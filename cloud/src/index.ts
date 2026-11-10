// Deskpad cloud API. The Worker is the only code with bindings to the tenant
// objects and the bucket, and the only place a tenant is chosen: `authenticate`
// turns the caller's credentials into { tenant, device }, and every handler
// below works from that pair alone. Nothing in a URL or body can name a tenant.
//
// See docs/sync-architecture.md.

import { IMAGE_MAX_BYTES, IMAGE_NAME, type SyncRequest } from "../../shared/protocol";
import { TenantDO } from "./tenant-do";

export { TenantDO };

interface Caller {
  tenant: string;
  device: string;
}

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
 * Who is calling. Step 1 of the design: device tokens issued by hand. The
 * `DEVICE_TOKENS` secret is a JSON object mapping the SHA-256 of each token to
 * its { tenant, device }, so the secret never holds a usable token. Better
 * Auth sessions replace this function later; nothing below it changes.
 */
async function authenticate(req: Request, env: Env): Promise<Caller | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 32) return null;
  let table: Record<string, Caller>;
  try {
    table = JSON.parse(env.DEVICE_TOKENS || "{}");
  } catch {
    return null;
  }
  const hit = table[await sha256Hex(token)];
  if (!hit || !TENANT_ID.test(hit.tenant ?? "") || !DEVICE_ID.test(hit.device ?? "")) return null;
  return { tenant: hit.tenant, device: hit.device };
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
    if (!path.startsWith("/api/v1/")) return fail(404, "Not found");

    const caller = await authenticate(req, env);
    if (!caller) return fail(401, "Not signed in");

    try {
      if (path === "/api/v1/sync" && req.method === "POST") {
        const body = (await req.json()) as SyncRequest;
        if (!body || typeof body !== "object") return fail(400, "Bad request");
        return json(await tenantStub(env, caller).sync(caller.tenant, caller.device, body));
      }

      if (path === "/api/v1/export" && req.method === "GET") {
        return json(await tenantStub(env, caller).exportAll(caller.tenant));
      }

      if (path === "/api/v1/status" && req.method === "GET") {
        return json({ tenant: caller.tenant, device: caller.device, ...(await tenantStub(env, caller).stats(caller.tenant)) });
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
          const declared = Number(req.headers.get("content-length") ?? "0");
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
      console.error("request failed", { path, tenant: caller.tenant, message: err instanceof Error ? err.message : String(err) });
      return fail(500, "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
