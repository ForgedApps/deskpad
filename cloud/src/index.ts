// Deskpad cloud API. The Worker is the only code with bindings to the tenant
// objects and the bucket, and the only place a tenant is chosen: `authenticate`
// turns the caller's credentials into { tenant, device }, and every handler
// below works from that pair alone. Nothing in a URL or body can name a tenant.
//
// See docs/sync-architecture.md.

import { IMAGE_MAX_BYTES, IMAGE_NAME, type SyncRequest } from "../../shared/protocol";
import { requireMcpAuth } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { callerFromSession, createAuth, googleConfigured, googleToken, mcpResource, migrate, NOTES_READ, tenantOfUser, type Caller } from "./auth";
import { handleMcp } from "./mcp";
import { TenantDO } from "./tenant-do";

export { TenantDO };

/** Every Better Auth route that is served; see the `/api/auth/` branch below. */
const AUTH_ROUTES = new Set([
  "/sign-in/social",
  "/callback/google",
  "/get-session",
  "/sign-out",
  "/error",
  // The desktop's sign-in.
  "/device",
  "/device/code",
  "/device/token",
  "/device/approve",
  "/device/deny",
  // OAuth for MCP clients.
  "/oauth2/authorize",
  "/oauth2/consent",
  "/oauth2/token",
  "/oauth2/register",
  "/oauth2/revoke",
  "/oauth2/public-client",
  "/jwks",
]);
/** Password sign-in exists for the automated tests only. */
const TEST_AUTH_ROUTES = new Set(["/sign-up/email", "/sign-in/email"]);
/** Largest request body `/sync` reads: two full pages of rows is far below this. */
const SYNC_MAX_BYTES = 16 * 1024 * 1024;

const TENANT_ID = /^[a-z0-9_-]{3,64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });

const fail = (status: number, error: string) => json({ error }, status);

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Who is calling. A Better Auth session (the web app's cookie, or the bearer
 * token the desktop got from the device sign-in flow) is the normal way.
 *
 * `DEVICE_TOKENS` is a second, optional way for tests and automation: a JSON
 * object mapping the SHA-256 of a hand-issued token to its { tenant, device }.
 * It is consulted only when that secret is set, which production does not do.
 */
async function authenticate(req: Request, env: Env, origin: string): Promise<Caller | null> {
  if (env.DEVICE_TOKENS) {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token.length >= 32) {
      try {
        const table = JSON.parse(env.DEVICE_TOKENS) as Record<string, Caller>;
        const hit = table[await sha256Hex(token)];
        if (hit && TENANT_ID.test(hit.tenant ?? "") && DEVICE_ID.test(hit.device ?? "")) return { tenant: hit.tenant, device: hit.device };
      } catch {
        // fall through to sessions
      }
    }
  }
  if (!env.BETTER_AUTH_SECRET) return null;
  // No credentials at all: don't spend a database read finding that out.
  if (!req.headers.get("authorization") && !req.headers.get("cookie")) return null;
  return callerFromSession(createAuth(env, origin), env, req);
}

/** The caller's own object; the name comes from `authenticate` and nowhere else. */
function tenantStub(env: Env, caller: Caller) {
  return env.TENANT.get(env.TENANT.idFromName(caller.tenant));
}

/** The caller's own key space in the bucket. `name` must already be validated. */
const imageKey = (caller: Caller, name: string) => `t/${caller.tenant}/img/${name}`;

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/v1/health") return json({ ok: true });
    // What the sign-in pages may offer; nothing secret.
    if (path === "/api/v1/auth-methods") return json({ google: googleConfigured(env) });

    // Better Auth's endpoints, but only the ones our pages and apps use. The
    // library ships many more (linking accounts, listing sessions, and one
    // that returns the stored Google refresh token to any session); none of
    // those is reachable.
    if (path.startsWith("/api/auth/")) {
      if (!env.BETTER_AUTH_SECRET) return fail(503, "Sign-in is not configured on this server");
      const route = path.slice("/api/auth".length);
      const allowed = AUTH_ROUTES.has(route) || (env.ALLOW_PASSWORD === "1" && TEST_AUTH_ROUTES.has(route));
      if (!allowed) return fail(404, "Not found");
      return createAuth(env, url.origin).handler(req);
    }

    // OAuth discovery for MCP clients: who issues tokens, and what /mcp is.
    // Public by design; none of it is about any account.
    if (path.startsWith("/.well-known/")) {
      if (!env.BETTER_AUTH_SECRET) return fail(404, "Not found");
      if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed");
      const auth = createAuth(env, url.origin);
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/api/auth") {
        return oauthProviderAuthServerMetadata(auth)(req);
      }
      if (path === "/.well-known/openid-configuration" || path === "/.well-known/openid-configuration/api/auth" || path === "/api/auth/.well-known/openid-configuration") {
        return oauthProviderOpenIdConfigMetadata(auth)(req);
      }
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return auth.handler(req);
      return fail(404, "Not found");
    }

    // The notes for AI clients (mcp.ts). The only credential accepted is an
    // access token this server issued for this URL; a session cookie or the
    // desktop's token does not open it, and an MCP token opens nothing else.
    if (path === "/mcp") {
      if (!env.BETTER_AUTH_SECRET) return fail(404, "Not found");
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      const auth = createAuth(env, url.origin);
      const guarded = requireMcpAuth(
        auth,
        async (request, claims) => {
          const tenant = typeof claims.sub === "string" ? await tenantOfUser(env, claims.sub) : null;
          if (!tenant) return fail(403, "This account no longer exists");
          return handleMcp(request, { tenant, stub: env.TENANT.get(env.TENANT.idFromName(tenant)), files: env.FILES });
        },
        { resource: mcpResource(url.origin), requiredScopes: [NOTES_READ] },
      );
      try {
        return await guarded(req);
      } catch (err) {
        console.error("mcp failed", { message: err instanceof Error ? err.message : String(err) });
        return fail(500, "Something went wrong");
      }
    }

    // Create or update the control-plane tables. Run once after each deploy
    // that changes them, with the ADMIN_KEY secret.
    if (path === "/api/admin/migrate" && req.method === "POST") {
      const key = req.headers.get("x-admin-key") ?? "";
      if (!env.ADMIN_KEY || key.length < 24 || (await sha256Hex(key)) !== (await sha256Hex(env.ADMIN_KEY))) return fail(404, "Not found");
      return json({ ok: true, changes: await migrate(env, url.origin) });
    }

    if (!path.startsWith("/api/v1/")) return fail(404, "Not found");

    // A session cookie is sent by the browser on its own, so anything that
    // changes data must come from our own pages.
    if (req.method !== "GET" && req.method !== "HEAD" && !req.headers.get("authorization")) {
      const from = req.headers.get("origin");
      if (from !== url.origin) return fail(403, "Cross-site request refused");
    }

    // One credential per request. A request that carries an Authorization
    // header skipped the origin check above, so it must not fall back to the
    // browser's cookie if that header turns out to be worthless.
    if (req.headers.get("authorization") && req.headers.get("cookie")) {
      const headers = new Headers(req.headers);
      headers.delete("cookie");
      req = new Request(req, { headers });
    }

    // Topic file names are note content; keep them out of the logs.
    const logPath = path.startsWith("/api/v1/vault/") ? "/api/v1/vault/*" : path;

    let caller: Caller | null;
    try {
      caller = await authenticate(req, env, url.origin);
    } catch (err) {
      // "Could not check" is not "not signed in": a client must not drop its session over this.
      console.error("auth failed", { path: logPath, message: err instanceof Error ? err.message : String(err) });
      return fail(503, "Sign-in is temporarily unavailable");
    }
    if (!caller) return fail(401, "Not signed in");

    try {
      if (path === "/api/v1/sync" && req.method === "POST") {
        const size = Number(req.headers.get("content-length") ?? "");
        if (!Number.isFinite(size) || size <= 0) return fail(411, "Length required");
        if (size > SYNC_MAX_BYTES) return fail(413, "Too much in one sync");
        const body = (await req.json()) as SyncRequest;
        if (!body || typeof body !== "object") return fail(400, "Bad request");
        // Cloudflare's guess at the caller's time zone decides which day a note is filed under.
        const tz = typeof req.cf?.timezone === "string" ? req.cf.timezone : undefined;
        return json(await tenantStub(env, caller).sync(caller.tenant, caller.device, body, { tz, origin: url.origin }));
      }

      // The notes as Markdown files (see vault.ts): the list, one zip, or one file.
      if (path === "/api/v1/vault" && req.method === "GET") {
        return json({ files: await tenantStub(env, caller).vaultList(caller.tenant) });
      }
      if (path === "/api/v1/vault.zip" && req.method === "GET") {
        const bytes = await tenantStub(env, caller).vaultZip(caller.tenant);
        return new Response(bytes, {
          headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="deskpad-notes.zip"', "cache-control": "private, no-store" },
        });
      }
      if (path.startsWith("/api/v1/vault/") && req.method === "GET") {
        let file: string;
        try {
          file = decodeURIComponent(path.slice("/api/v1/vault/".length));
        } catch {
          return fail(400, "Bad file name");
        }
        if (file.includes("..") || file.includes("\\") || !/^(?:[^/]+\/)?[^/]+\.md$/.test(file)) return fail(400, "Bad file name");
        // Brings the files up to date before reading one.
        await tenantStub(env, caller).vaultList(caller.tenant);
        const obj = await env.FILES.get(`t/${caller.tenant}/md/${file}`);
        if (!obj) return fail(404, "No such file");
        return new Response(obj.body, {
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
        });
      }

      if (path === "/api/v1/export" && req.method === "GET") {
        return json(await tenantStub(env, caller).exportAll(caller.tenant));
      }

      // The account's Google access, for the calendar. Only a session has one.
      if (path === "/api/v1/google-token" && req.method === "GET") {
        const token = env.BETTER_AUTH_SECRET ? await googleToken(createAuth(env, url.origin), env, req) : null;
        return token ? json(token) : fail(404, "This account has no Google access");
      }

      if (path === "/api/v1/status" && req.method === "GET") {
        return json({ tenant: caller.tenant, device: caller.device, account: caller.account ?? null, ...(await tenantStub(env, caller).stats(caller.tenant)) });
      }

      if (path.startsWith("/api/v1/images/")) {
        const name = path.slice("/api/v1/images/".length);
        if (!IMAGE_NAME.test(name)) return fail(400, "Bad image name");
        const key = imageKey(caller, name);

        if (req.method === "HEAD") {
          const head = await env.FILES.head(key);
          return new Response(null, { status: head ? 200 : 404, headers: { "cache-control": "private, no-store" } });
        }

        if (req.method === "GET") {
          const obj = await env.FILES.get(key);
          if (!obj) return fail(404, "No such image");
          return new Response(obj.body, {
            headers: {
              "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
              "content-length": String(obj.size),
              // Content-addressed, so it never changes; private because it is one tenant's.
              "cache-control": "private, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
            },
          });
        }

        if (req.method === "PUT") {
          // Without a declared length the whole body would be buffered before it could be refused.
          const declared = Number(req.headers.get("content-length") ?? "");
          if (!Number.isFinite(declared) || declared <= 0) return fail(411, "Length required");
          if (declared > IMAGE_MAX_BYTES) return fail(413, "Image too large");
          const bytes = await req.arrayBuffer();
          if (bytes.byteLength === 0) return fail(400, "Empty image");
          if (bytes.byteLength > IMAGE_MAX_BYTES) return fail(413, "Image too large");
          // The name is the content's hash, so a client can't overwrite one image with another.
          if ((await sha256Hex(bytes)).slice(0, 20) !== name.slice(0, 20)) return fail(400, "Name does not match content");
          const ext = name.split(".").pop() ?? "";
          const type = TYPES[ext];
          if (!type) return fail(415, "Unsupported image type");
          if (!(await env.FILES.head(key))) {
            await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
          }
          return json({ ok: true, name });
        }
      }

      return fail(404, "Not found");
    } catch (err) {
      // Ids and sizes only; never request bodies.
      console.error("request failed", { path: logPath, tenant: caller.tenant, message: err instanceof Error ? err.message : String(err) });
      return fail(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
