// Identity. Better Auth runs inside the Worker with the D1 control-plane
// database as its store: users, sessions and sign-in methods are rows we own.
// The data plane never sees any of this. `callerFromSession` turns a session
// (the web app's cookie, or the desktop's bearer token from the device flow)
// into the { tenant, device } pair every handler in index.ts works from.
//
// There is one way in: "Continue with Google". Signing in and signing up are
// the same step (an unknown Google account gets a Deskpad account), and the
// same consent asks for the Calendar access the apps need, so the calendar is
// not a second connection. Google's tokens stay here, encrypted; a signed-in
// device asks for a short-lived access token when it needs one (`googleToken`).

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { jwt } from "better-auth/plugins/jwt";
import { mcp } from "@better-auth/mcp";

/** The only client the device flow serves: the Windows app. */
export const DESKTOP_CLIENT = "deskpad-desktop";

export interface Caller {
  tenant: string;
  device: string;
  /** The signed-in account's email, for "Signed in as …" in the apps. */
  account?: string;
}

/** Read every calendar the user has; create and change events. */
export const CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_WRITE = "https://www.googleapis.com/auth/calendar.events";

/** What an MCP token may do: read the notes. There is no write scope. */
export const NOTES_READ = "notes:read";

export const googleConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/**
 * The MCP endpoint's identity as an OAuth resource: access tokens are issued
 * for exactly this URL and `/mcp` accepts no other audience. `wrangler dev`
 * reports the custom domain over http, which the plugin refuses, so the scheme
 * is fixed up there; nothing but tests runs that way.
 */
export function mcpResource(origin: string): string {
  const u = new URL(origin);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return `${local ? u.protocol : "https:"}//${u.host}/mcp`;
}

/** Bindings exist only inside a request, so the instance is built per request. */
export function createAuth(env: Env, origin: string) {
  const google = googleConfigured(env)
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          scope: [CALENDAR_READ, CALENDAR_WRITE],
          // Offline access plus a consent prompt is what makes Google hand
          // over a refresh token every time, not only on the first sign-in.
          accessType: "offline" as const,
          prompt: "select_account consent" as const,
        },
      }
    : {};
  return betterAuth({
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    // The jwt plugin's own /token would mint session JWTs with the key that
    // signs MCP access tokens; nothing here uses it.
    disabledPaths: ["/token"],
    // Passwords exist only for the automated tests (ALLOW_PASSWORD=1 in their
    // environment); no page offers them.
    // Never together with open sign-up: an unverified email could be registered ahead of its owner.
    emailAndPassword: { enabled: env.ALLOW_PASSWORD === "1" && (env.SIGNUP as string) !== "open", minPasswordLength: 10, autoSignIn: true },
    // Counted in D1, because a Worker's memory is per instance and short-lived.
    // Device codes, client registrations and sign-in attempts all write rows
    // without a session, so they must not be free to repeat.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/device/code": { window: 60, max: 10 },
        "/oauth2/register": { window: 60, max: 10 },
        "/sign-in/social": { window: 60, max: 20 },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    socialProviders: google,
    // Google's refresh token is a standing key to someone's calendar.
    account: { encryptOAuthTokens: true },
    session: {
      // A device stays signed in as long as it is used at least once in 90 days.
      expiresIn: 60 * 60 * 24 * 90,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "10m",
        interval: "3s",
        validateClient: (clientId) => clientId === DESKTOP_CLIENT,
      }),
      // OAuth for AI clients that read the notes over MCP (index.ts, mcp.ts).
      // A client such as Claude registers itself, the user signs in with
      // Google on /connect and approves it there, and the client gets a token
      // that is good for /mcp only. Registration is open because MCP clients
      // expect it; a registered client can do nothing until a signed-in user
      // approves it by name.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: "/connect",
        consentPage: "/connect",
        resource: mcpResource(origin),
        scopes: ["openid", "offline_access", NOTES_READ],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Who may create an account. SIGNUP = "open" | "closed" | "first"
          // (the default: only while there is no account yet, which lets the
          // owner claim a fresh deployment and nobody after them).
          before: async (user) => {
            const mode: string = env.SIGNUP || "first";
            if (mode === "open") return { data: user };
            const n = mode === "closed" ? 1 : ((await env.DB.prepare("SELECT COUNT(*) AS n FROM user").first<{ n: number }>())?.n ?? 0);
            if (n > 0) throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this Deskpad server." });
            return { data: user };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Create or update the control-plane tables: Better Auth's own, then ours.
 * A user has memberships in tenants; today each user gets exactly one tenant
 * (their default), but the three are separate from the start so shared
 * workspaces are an insert later, not a migration.
 */
export async function migrate(env: Env, origin: string): Promise<string[]> {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(createAuth(env, origin).options);
  await runMigrations();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tenant (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS membership (user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, tenant_id))"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS membership_default ON membership(user_id) WHERE is_default = 1"),
  ]);
  return [...toBeCreated.map((t) => `created ${t.table}`), ...toBeAdded.map((t) => `altered ${t.table}`), "tenant, membership ready"];
}

const TENANT_ID = /^[a-z0-9_-]{3,64}$/;

/** The tenant a user works in, created on first use with an unguessable id. */
async function tenantOf(env: Env, userId: string, userName: string): Promise<string> {
  const find = () => env.DB.prepare("SELECT tenant_id FROM membership WHERE user_id = ? AND is_default = 1").bind(userId).first<{ tenant_id: string }>();
  const have = await find();
  if (have) return have.tenant_id;

  const id = `t_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const now = Date.now();
  // The unique index on a user's default membership settles a race between two
  // first requests: one insert wins, the other is ignored, both read the winner.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO tenant (id, name, created_at) VALUES (?, ?, ?)").bind(id, userName || "Personal", now),
    env.DB.prepare("INSERT OR IGNORE INTO membership (user_id, tenant_id, role, is_default, created_at) VALUES (?, ?, 'owner', 1, ?)").bind(userId, id, now),
  ]);
  const made = await find();
  if (!made) throw new Error("could not create a tenant");
  return made.tenant_id;
}

/** The tenant behind an MCP access token's subject, or null when that user is gone. */
export async function tenantOfUser(env: Env, userId: string): Promise<string | null> {
  const user = await env.DB.prepare("SELECT name FROM user WHERE id = ?").bind(userId).first<{ name: string | null }>();
  if (!user) return null;
  const tenant = await tenantOf(env, userId, user.name ?? "");
  return TENANT_ID.test(tenant) ? tenant : null;
}

/** Who a request's session belongs to, or null when it has none. */
export async function callerFromSession(auth: Auth, env: Env, req: Request): Promise<Caller | null> {
  const got = await auth.api.getSession({ headers: req.headers });
  if (!got?.user?.id || !got.session?.id) return null;
  const tenant = await tenantOf(env, got.user.id, got.user.name ?? "");
  if (!TENANT_ID.test(tenant)) return null;
  // One session is one device; its id names the device in the tenant's rows.
  const device = got.session.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "device";
  return { tenant, device, account: got.user.email };
}

/**
 * A current Google access token for the signed-in account, refreshed here if
 * it had expired, and what it may be used for. Null when the account has no
 * Google grant (or Google no longer honours it).
 */
export async function googleToken(auth: Auth, env: Env, req: Request): Promise<{ access_token: string; expires_at: number; calendar_read: boolean; calendar_write: boolean } | null> {
  try {
    const got = await auth.api.getSession({ headers: req.headers });
    if (!got?.user?.id) return null;
    // The account is looked up by the session's own user, never by anything the caller sends.
    const account = await env.DB.prepare("SELECT id FROM account WHERE userId = ? AND providerId = 'google' LIMIT 1").bind(got.user.id).first<{ id: string }>();
    if (!account) return null;
    const t = await auth.api.getAccessToken({ body: { accountId: account.id }, headers: req.headers });
    if (!t?.accessToken) return null;
    const scopes: string[] = t.scopes ?? [];
    const expires = t.accessTokenExpiresAt ? Math.floor(new Date(t.accessTokenExpiresAt).getTime() / 1000) : Math.floor(Date.now() / 1000) + 300;
    return { access_token: t.accessToken, expires_at: expires, calendar_read: scopes.includes(CALENDAR_READ), calendar_write: scopes.includes(CALENDAR_WRITE) };
  } catch {
    return null;
  }
}
