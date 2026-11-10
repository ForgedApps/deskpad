// Identity. Better Auth runs inside the Worker with the D1 control-plane
// database as its store: users, sessions and sign-in methods are rows we own.
// The data plane never sees any of this. `callerFromSession` turns a session
// (the web app's cookie, or the desktop's bearer token from the device flow)
// into the { tenant, device } pair every handler in index.ts works from.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";

/** The only client the device flow serves: the Windows app. */
export const DESKTOP_CLIENT = "deskpad-desktop";

export interface Caller {
  tenant: string;
  device: string;
  /** The signed-in account's email, for "Signed in as …" in the apps. */
  account?: string;
}

/** Bindings exist only inside a request, so the instance is built per request. */
export function createAuth(env: Env, origin: string) {
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {};
  return betterAuth({
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
    socialProviders: google,
    session: {
      // A device stays signed in as long as it is used at least once in 90 days.
      expiresIn: 60 * 60 * 24 * 90,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "15m",
        interval: "3s",
        validateClient: (clientId) => clientId === DESKTOP_CLIENT,
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

/**
 * The tenant a user works in, created on first use. `FIRST_TENANT` lets the
 * very first tenant take a fixed id, so data synced before accounts existed
 * (under hand-issued tokens) carries over to the first account.
 */
async function tenantOf(env: Env, userId: string, userName: string): Promise<string> {
  const find = () => env.DB.prepare("SELECT tenant_id FROM membership WHERE user_id = ? AND is_default = 1").bind(userId).first<{ tenant_id: string }>();
  const have = await find();
  if (have) return have.tenant_id;

  let id = `t_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const first = env.FIRST_TENANT ?? "";
  if (TENANT_ID.test(first)) {
    const any = await env.DB.prepare("SELECT COUNT(*) AS n FROM tenant").first<{ n: number }>();
    if ((any?.n ?? 0) === 0) id = first;
  }
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
