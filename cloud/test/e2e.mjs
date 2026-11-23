// End-to-end checks against a local `wrangler dev` (Miniflare): the merge
// rules, paging-free pull, images, and above all tenant isolation. Run with
// `npm test` in cloud/. It starts its own server on a scratch state directory
// with throwaway tokens, so it never touches real data.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

const tok = { a1: randomBytes(24).toString("hex"), a2: randomBytes(24).toString("hex"), b1: randomBytes(24).toString("hex") };
const table = {
  [sha(tok.a1)]: { tenant: "tenant-a", device: "a1" },
  [sha(tok.a2)]: { tenant: "tenant-a", device: "a2" },
  [sha(tok.b1)]: { tenant: "tenant-b", device: "b1" },
};
const state = mkdtempSync(join(tmpdir(), "deskpad-cloud-test-"));
const vars = join(state, "vars");
const ADMIN = randomBytes(24).toString("hex");
writeFileSync(vars, `DEVICE_TOKENS=${JSON.stringify(table)}\nBETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\nADMIN_KEY=${ADMIN}\nALLOW_PASSWORD=1\nGOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=test-secret\n`);

let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures++;
};

const call = (token, path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
const sync = async (token, since, rows = [], days = []) => {
  const r = await call(token, "/sync", { method: "POST", body: JSON.stringify({ since, rows, days }), headers: { "content-type": "application/json" } });
  if (!r.ok) throw new Error(`sync ${r.status}: ${await r.text()}`);
  return r.json();
};
const row = (id, text, updated_at, extra = {}) => ({
  id, text, kind: "note", done: false, parent: null, rank: "V", created_at: 1_794_000_000, done_at: null,
  schedule: null, archived_at: null, updated_at, updated_by: "ignored", deleted: false, ...extra,
});

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", join(state, "persist"), "--env-file", vars, "--show-interactive-dev-session=false"], {
  cwd: root,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const stop = () => {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
  else server.kill("SIGTERM");
};

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error(`server did not start:\n${log}`);

  // --- control plane ---
  const ORIGIN0 = `http://127.0.0.1:${PORT}`;
  ok((await call("x".repeat(48), "/status")).status === 503, "before the tables exist, a session check says unavailable, not signed out");
  ok((await fetch(`${ORIGIN0}/api/admin/migrate`, { method: "POST" })).status === 404, "migrate without the admin key is not found");
  const mig = await fetch(`${ORIGIN0}/api/admin/migrate`, { method: "POST", headers: { "x-admin-key": ADMIN } });
  ok(mig.status === 200, "migrate with the admin key creates the tables");
  ok((await fetch(`${ORIGIN0}/api/admin/migrate`, { method: "POST", headers: { "x-admin-key": ADMIN } })).status === 200, "migrate is repeatable");

  // --- auth ---
  ok((await call(null, "/status")).status === 401, "no token is refused");
  ok((await call("x".repeat(48), "/status")).status === 401, "unknown token is refused");
  ok((await call(tok.a1, "/status")).status === 200, "known token is accepted");

  // --- push, pull, echo ---
  const t = Date.now();
  let r = await sync(tok.a1, 0, [row("100", "first", t), row("101", "child", t, { parent: "100" })]);
  ok(r.rows.length === 2 && r.seq === 2, "push returns the accepted rows with seq");
  ok(r.rows.every((x) => x.updated_by === "a1"), "device comes from the token, not the body");
  r = await sync(tok.a2, 0);
  ok(r.rows.length === 2 && r.rows[1].parent === "100", "second device pulls both rows");
  const a2since = r.seq;
  r = await sync(tok.a2, a2since);
  ok(r.rows.length === 0 && r.seq === a2since, "nothing new means an empty pull");

  // --- last writer wins ---
  r = await sync(tok.a2, a2since, [row("100", "edited on a2", t + 10)]);
  ok(r.rows.length === 1 && r.rows[0].text === "edited on a2", "newer edit is accepted");
  r = await sync(tok.a1, 2, [row("100", "stale edit from a1", t + 5)]);
  ok(r.rows.some((x) => x.id === "100" && x.text === "edited on a2"), "older edit is refused and the winner comes back");
  r = await sync(tok.a1, r.seq, [row("100", "stale again", t + 5)]);
  ok(r.rows.length === 1 && r.rows[0].text === "edited on a2", "a refused row returns the server copy even when already seen");
  r = await sync(tok.a1, r.seq, [row("100", "tie from a1", t + 10)]);
  ok(r.rows[0].text === "edited on a2", "a tie goes to the larger device id (a2 over a1)");

  // --- tombstones and archive ---
  r = await sync(tok.a1, r.seq, [row("101", "", t + 20, { deleted: true }), row("100", "edited on a2", t + 30, { archived_at: 1_794_000_500 })]);
  ok(r.rows.find((x) => x.id === "101")?.deleted === true, "delete is a tombstone");
  ok(r.rows.find((x) => x.id === "100")?.archived_at === 1_794_000_500, "archiving is an edit");
  let st = await (await call(tok.a1, "/status")).json();
  ok(st.rows === 1 && st.deleted === 1, "status counts live rows and tombstones");

  // --- validation ---
  r = await sync(tok.a1, st.seq, [{ id: "bad id!", text: "x", updated_at: t, created_at: 1 }, { id: "200", updated_at: t, created_at: 1 }, row("201", "future", t + 86_400_000)]);
  ok(r.rows.length === 1 && r.rows[0].id === "201" && r.rows[0].updated_at < t + 600_000, "bad rows are dropped and future clocks are capped");

  // --- days ---
  r = await sync(tok.a1, r.seq, [], [{ day: "2026-11-09", events: [{ title: "Standup" }], updated_at: t, updated_by: "x" }]);
  ok(r.days.length === 1 && r.days[0].events[0].title === "Standup", "day events round-trip");

  // --- images ---
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const name = `${sha(png).slice(0, 20)}.png`;
  ok((await call(tok.a1, `/images/${name}`, { method: "PUT", body: png })).status === 200, "image upload");
  ok((await call(tok.a1, `/images/${name}`, { method: "PUT", body: png })).status === 200, "image upload is idempotent");
  const got = await call(tok.a2, `/images/${name}`);
  ok(got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(png), "another device of the tenant reads it back");
  ok((await call(tok.a1, `/images/${"0".repeat(20)}.png`, { method: "PUT", body: png })).status === 400, "name must match the content hash");
  ok((await call(tok.a1, "/images/..%2f..%2fx.png", { method: "PUT", body: png })).status === 400, "path tricks are refused");

  // --- isolation ---
  r = await sync(tok.b1, 0);
  ok(r.rows.length === 0 && r.days.length === 0 && r.seq === 0, "tenant B starts empty: sees none of A's rows or days");
  ok((await call(tok.b1, `/images/${name}`)).status === 404, "tenant B cannot read A's image");
  ok((await call(tok.b1, `/images/${name}`, { method: "HEAD" })).status === 404, "tenant B cannot probe A's image");
  r = await sync(tok.b1, 0, [row("100", "B's own row 100", t + 999)]);
  ok(r.rows.length === 1 && r.seq === 1, "tenant B has its own change counter");
  const ea = await (await call(tok.a1, "/export")).json();
  const eb = await (await call(tok.b1, "/export")).json();
  ok(ea.tenant === "tenant-a" && ea.rows.find((x) => x.id === "100")?.text === "edited on a2", "same id in B did not touch A's row");
  ok(eb.tenant === "tenant-b" && eb.rows.length === 1 && eb.rows[0].text === "B's own row 100" && eb.days.length === 0, "B's export holds only B's data");
  ok(!JSON.stringify(eb).includes("edited on a2") && !JSON.stringify(ea).includes("B's own"), "no text crosses between exports");
  // A tenant named in the request must be ignored.
  const sneaky = await fetch(`${BASE}/export?tenant=tenant-a`, { headers: { authorization: `Bearer ${tok.b1}`, "x-tenant": "tenant-a" } });
  ok((await sneaky.json()).tenant === "tenant-b", "a tenant named in the URL or a header is ignored");

  // --- accounts (Better Auth) ---
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const auth = (path, body, token) =>
    fetch(`${ORIGIN}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const pw = randomBytes(12).toString("hex");
  const signUp = await auth("/sign-up/email", { email: "owner@example.test", password: pw, name: "Owner" });
  const web = signUp.headers.get("set-auth-token");
  ok(signUp.status === 200 && !!web, "the first account can sign up and gets a session");
  const second = await auth("/sign-up/email", { email: "other@example.test", password: pw, name: "Other" });
  ok(second.status === 403, "a second sign-up is refused while SIGNUP is \"first\"");
  ok((await auth("/sign-in/email", { email: "owner@example.test", password: "wrong-password-x" })).status === 401, "a wrong password is refused");

  st = await (await call(web, "/status")).json();
  ok(st.account === "owner@example.test" && /^[a-z0-9_-]{3,64}$/.test(st.tenant), "a session resolves to the account's tenant");
  const ownerTenant = st.tenant;
  ok(ownerTenant !== "tenant-a" && ownerTenant !== "tenant-b" && st.rows === 0, "the account's tenant is its own and starts empty");

  // The desktop's sign-in: loopback redirect with PKCE. The app makes a
  // verifier, the browser approves with its challenge, the one-time code goes
  // to 127.0.0.1 only, and the app trades code + verifier for a session.
  const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0];
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const linkVerifier = b64u(randomBytes(32));
  const link = { challenge: b64u(createHash("sha256").update(linkVerifier).digest()), port: 53111, state: b64u(randomBytes(16)) };
  const approve = (headers, body = link) => fetch(`${BASE}/link/approve`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const trade = (code, v = linkVerifier) => fetch(`${BASE}/link/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier: v }) });
  ok((await approve({ origin: ORIGIN })).status === 401, "nobody can approve a desktop sign-in without being signed in");
  ok((await approve({ cookie, origin: "https://evil.example" })).status === 403, "a cross-site approval is refused");
  ok((await approve({ authorization: `Bearer ${web}` })).status === 403, "a bearer token cannot approve one; only the browser can");
  ok((await approve({ cookie, origin: ORIGIN }, { ...link, port: 80 })).status === 400 && (await approve({ cookie, origin: ORIGIN }, { ...link, challenge: "short" })).status === 400, "a bad port or challenge is refused");
  const linked = await approve({ cookie, origin: ORIGIN });
  const linkBack = new URL((await linked.json()).url ?? "http://invalid");
  ok(linked.status === 200 && linkBack.origin === "http://127.0.0.1:53111" && linkBack.pathname === "/callback" && linkBack.searchParams.get("state") === link.state, "approval sends the code to 127.0.0.1 at the app's port, nowhere else");
  const linkCode = linkBack.searchParams.get("code");
  ok((await trade(linkCode, b64u(randomBytes(32)))).status === 400, "the code is useless without the app's verifier");
  ok((await trade(linkCode)).status === 400, "and a failed try burns it");
  const approved2 = await approve({ cookie, origin: ORIGIN });
  const code2 = new URL((await approved2.json()).url).searchParams.get("code");
  const traded = await trade(code2);
  const granted = { access_token: (await traded.json()).token };
  ok(traded.status === 200 && typeof granted.access_token === "string" && granted.access_token.length >= 32, "the desktop receives its own session token");
  ok((await trade(code2)).status === 400, "a code works only once");
  ok((await auth("/device/code", { client_id: "deskpad-desktop" })).status === 404, "the old device-code sign-in is gone");
  const dst = await (await call(granted.access_token, "/status")).json();
  ok(dst.tenant === ownerTenant && dst.device !== st.device, "the desktop lands in the same tenant as a separate device");
  r = await sync(granted.access_token, 0, [row("900", "from the desktop", Date.now())]);
  ok(r.rows.length === 1, "the desktop session can sync");
  r = await sync(web, 0);
  ok(r.rows.length === 1 && r.rows[0].text === "from the desktop", "the browser session sees the desktop's row");
  ok((await sync(tok.a1, 0)).rows.every((x) => x.text !== "from the desktop"), "token tenant A still sees none of the account's rows");

  // Cookie sessions must not accept cross-site writes.
  const body = JSON.stringify({ since: 0, rows: [], days: [] });
  const xs = await fetch(`${BASE}/sync`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body });
  ok(xs.status === 403, "a cross-site POST with the session cookie is refused");
  const same = await fetch(`${BASE}/sync`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body });
  ok(same.status === 200, "the same POST from our own origin works with the cookie");

  // Only the sign-in routes we use exist; the library's account and token routes do not.
  for (const hidden of ["/list-accounts", "/refresh-token", "/get-access-token", "/list-sessions", "/update-user", "/link-social", "/token", "/oauth2/create-client", "/oauth2/get-clients"]) {
    const res = await fetch(`${ORIGIN}/api/auth${hidden}`, { method: hidden.startsWith("/list") || hidden === "/token" || hidden.endsWith("get-clients") ? "GET" : "POST", headers: { authorization: `Bearer ${web}`, "content-type": "application/json" }, body: hidden.startsWith("/list") || hidden === "/token" || hidden.endsWith("get-clients") ? undefined : "{}" });
    ok(res.status === 404, `${hidden} is not served`);
  }
  // A worthless Authorization header must not let the cookie through past the origin check.
  const sneaky2 = await fetch(`${BASE}/sync`, { method: "POST", headers: { cookie, authorization: "Bearer nothing", origin: "https://evil.example", "content-type": "application/json" }, body });
  ok(sneaky2.status === 401, "a cookie is ignored when an Authorization header is sent");
  // Dates no calendar has must not break the Markdown copy.
  await sync(web, 0, [row("901", "odd dates", Date.now(), { created_at: 9e15, done_at: -5, schedule: { start: 9e15, end: 9e15, all_day: false, event_id: null } })], [{ day: "9999-99-99", events: [], updated_at: Date.now(), updated_by: "x" }]);
  ok((await call(web, "/vault")).status === 200, "rows with impossible dates do not break the vault");

  // Google is the only sign-in offered; here it isn't configured, and a password account has no Google grant.
  ok((await (await fetch(`${BASE}/auth-methods`)).json()).google === true, "auth-methods reports that Google sign-in is set up");
  const social = await (await auth("/sign-in/social", { provider: "google", callbackURL: "/device?user_code=ABCD", errorCallbackURL: "/device" })).json();
  const g = new URL(social.url ?? "http://invalid");
  const scope = g.searchParams.get("scope") ?? "";
  ok(g.hostname === "accounts.google.com" && g.searchParams.get("client_id") === "test-client.apps.googleusercontent.com", "Continue with Google sends the browser to Google with our client");
  // `wrangler dev` reports the configured custom domain as the host, so only the path is compared.
  ok(new URL(g.searchParams.get("redirect_uri") ?? "http://invalid").pathname === "/api/auth/callback/google", "the redirect is this server's callback");
  ok(scope.includes("calendar.readonly") && scope.includes("calendar.events") && scope.includes("email"), "one consent asks for sign-in and the calendar");
  ok(g.searchParams.get("access_type") === "offline" && (g.searchParams.get("prompt") ?? "").includes("consent"), "and for a refresh token every time");
  ok((await call(web, "/google-token")).status === 404, "an account without a Google grant has no calendar token");
  ok((await call(tok.a1, "/google-token")).status === 404, "nor does a test token");

  // --- MCP: an AI client registers, the user approves it, it reads notes ---
  // `wrangler dev` names the custom domain in the URLs it hands out; follow them on the local port.
  const here = (u) => { const x = new URL(u, ORIGIN0); return ORIGIN0 + x.pathname + x.search; };
  const rpc = (token, method, params, id = 1) =>
    fetch(`${ORIGIN0}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const anon = await rpc(null, "tools/list", {});
  const challenge = anon.headers.get("www-authenticate") ?? "";
  ok(anon.status === 401 && challenge.includes("resource_metadata"), "MCP without a token is refused and says where to get one");
  ok((await rpc(web, "tools/list", {})).status === 401, "a browser session token does not open MCP");
  ok((await rpc(tok.a1, "tools/list", {})).status === 401, "nor does a device token");
  ok((await fetch(`${ORIGIN0}/mcp`)).status === 405, "MCP answers POST only");
  const prm = await (await fetch(`${ORIGIN0}/.well-known/oauth-protected-resource`)).json();
  ok(String(prm.resource).endsWith("/mcp") && Array.isArray(prm.authorization_servers), "the resource metadata names /mcp and its authorization server");
  const asm = await (await fetch(`${ORIGIN0}/.well-known/oauth-authorization-server`)).json();
  ok(!!asm.authorization_endpoint && !!asm.token_endpoint && !!asm.registration_endpoint && (asm.code_challenge_methods_supported ?? []).includes("S256"), "the server metadata lists the endpoints and PKCE");
  const redirect_uri = "http://127.0.0.1:53999/callback";
  const reg = await fetch(here(asm.registration_endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test AI", redirect_uris: [redirect_uri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const client = await reg.json();
  ok(reg.ok && !!client.client_id, `an MCP client can register itself (${reg.status})`);
  const verifier = randomBytes(32).toString("base64url");
  const authz = new URL(here(asm.authorization_endpoint));
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri, scope: "notes:read offline_access", state: "s1", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: prm.resource })) authz.searchParams.set(k, v);
  // A browser navigation gets a 302; Node's fetch marks itself as a script and gets the same address as JSON.
  const next = async (res) => new URL(res.headers.get("location") ?? (await res.json().catch(() => ({}))).url ?? "http://invalid", ORIGIN0);
  const signIn = await next(await fetch(authz, { redirect: "manual" }));
  ok(signIn.pathname === "/connect" && !signIn.searchParams.has("code"), "authorizing without a session goes to the sign-in page");
  const consentAt = await next(await fetch(authz, { redirect: "manual", headers: { cookie } }));
  ok(consentAt.pathname === "/connect" && consentAt.searchParams.has("sig"), "a signed-in user is asked to approve, with a signed request");
  ok(!consentAt.searchParams.has("code"), "and no code is issued before approval");
  const oauth_query = consentAt.search.slice(1);
  const consent = (headers, q = oauth_query, accept = true) => fetch(`${ORIGIN0}/api/auth/oauth2/consent`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify({ accept, oauth_query: q }) });
  ok((await consent({})).status === 401, "nobody can approve without being signed in");
  ok(!(await consent({ cookie }, oauth_query.replace(/redirect_uri=[^&]+/, "redirect_uri=" + encodeURIComponent("https://evil.example/cb")))).ok, "a tampered request is not approved");
  const approved = await consent({ cookie });
  const back = new URL((await approved.json()).url ?? "http://invalid");
  ok(approved.ok && back.origin + back.pathname === redirect_uri && back.searchParams.get("state") === "s1" && !!back.searchParams.get("code"), "approval sends the app a code at its own address");
  const tokenReq = (extra) => fetch(here(asm.token_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri, code: back.searchParams.get("code"), resource: prm.resource, ...extra }) });
  ok(!(await tokenReq({ code_verifier: randomBytes(32).toString("base64url") })).ok, "the code is useless without the PKCE verifier");
  const tokRes = await tokenReq({ code_verifier: verifier });
  const mtok = await tokRes.json();
  ok(tokRes.ok && typeof mtok.access_token === "string", `the app exchanges the code for an access token (${tokRes.status} ${mtok.error ?? ""})`);
  const init = await (await rpc(mtok.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json();
  ok(init.result?.serverInfo?.name === "deskpad" && !!init.result.capabilities.tools, "MCP initializes with the token");
  const tools = (await (await rpc(mtok.access_token, "tools/list", {})).json()).result.tools.map((t) => t.name);
  ok(["get_outline", "list_files", "read_file", "search_notes"].every((t) => tools.includes(t)) && tools.length === 4, "it offers four read-only tools");
  const toolText = async (name, args) => (await (await rpc(mtok.access_token, "tools/call", { name, arguments: args })).json()).result.content[0].text;
  ok((await toolText("search_notes", { query: "desktop from" })).includes("from the desktop"), "search finds the account's own note");
  ok((await toolText("get_outline", {})).includes("from the desktop"), "the outline is readable");
  ok((await toolText("search_notes", { query: "edited" })) === "Nothing matched." && (await toolText("search_notes", { query: "first" })) === "Nothing matched.", "other tenants' notes are not found");
  ok((await toolText("read_file", { path: "../../tenant-a/md/outline.md" })).includes("not a file path"), "a path outside the vault is refused");
  ok((await call(mtok.access_token, "/status")).status === 401 && (await call(mtok.access_token, "/export")).status === 401, "an MCP token opens nothing but MCP");
  ok((await (await rpc(mtok.access_token, "notes/delete", {})).json()).error?.code === -32601, "there is nothing to call that writes");

  // --- the Markdown vault ---
  const vt = Date.now() + 60_000;
  await sync(tok.b1, 0, [
    row("v1", "Plan for [[Project Kestrel]] #idea", vt, { rank: "A", created_at: 1_794_000_000 }),
    row("v2", "call the vendor", vt, { rank: "A", parent: "v1", kind: "task", created_at: 1_794_000_100 }),
    row("v3", "old and archived, about [[Project Kestrel]]", vt, { rank: "B", archived_at: 1_794_100_000, created_at: 1_793_000_000 }),
    row("v4", "gone", vt, { rank: "C", deleted: true }),
  ], [{ day: "2026-11-06", events: [{ id: "e", title: "Standup", start: 1_794_000_600, end: 1_794_002_400, all_day: false, location: null, url: null }], updated_at: vt, updated_by: "x" }]);
  const vfiles = (await (await call(tok.b1, "/vault")).json()).files.map((f) => f.path);
  ok(vfiles.includes("outline.md") && vfiles.includes("index.md"), "the vault lists the outline and the index");
  ok(vfiles.includes("topics/Project Kestrel.md") && vfiles.includes("tags/idea.md"), "a [[link]] and a #tag each get a page");
  const vget = async (token, file) => {
    const res = await call(token, `/vault/${file.split("/").map(encodeURIComponent).join("/")}`);
    return { status: res.status, text: await res.text() };
  };
  const outlineMd = (await vget(tok.b1, "outline.md")).text;
  ok(/^- Plan for \[\[Project Kestrel\]\] #idea\n  - \[ \] call the vendor$/m.test(outlineMd), "the outline is nested bullets with task boxes");
  ok(!outlineMd.includes("archived") && !outlineMd.includes("gone"), "archived and deleted rows are not in the outline");
  const topicMd = (await vget(tok.b1, "topics/Project Kestrel.md")).text;
  ok(topicMd.includes("2 mentions") && topicMd.includes("old and archived"), "a topic page gathers its mentions, archived ones too");
  const dayFile = vfiles.find((f) => f.startsWith("daily/2026-11-0") && f !== "daily/2026-11-06.md") ?? "daily/2026-11-06.md";
  const dailies = (await Promise.all(vfiles.filter((f) => f.startsWith("daily/")).map((f) => vget(tok.b1, f)))).map((f) => f.text).join("\n");
  ok(dailies.includes("## Events") && dailies.includes("Standup") && dailies.includes("call the vendor"), `daily files hold events and that day's rows (${dayFile})`);
  ok((await vget(tok.a1, "topics/Project Kestrel.md")).status === 404, "another tenant cannot read the file");
  ok((await call(tok.b1, "/vault/x%5C..%5Cy.md")).status === 400 && (await call(tok.b1, "/vault/a/b/c.md")).status === 400 && (await call(tok.b1, "/vault/notes.txt")).status === 400, "paths outside the vault are refused");
  const zipped = new Uint8Array(await (await call(tok.b1, "/vault.zip")).arrayBuffer());
  ok(zipped[0] === 0x50 && zipped[1] === 0x4b && Buffer.from(zipped).includes("deskpad/outline.md"), "the zip holds the same files");
  await sync(tok.b1, 0, [row("v3", "old and archived, no link now", vt + 5, { rank: "B", archived_at: 1_794_100_000 }), row("v1", "Plan, untagged", vt + 5, { rank: "A" })]);
  ok(!(await (await call(tok.b1, "/vault")).json()).files.some((f) => f.path.startsWith("topics/")), "a topic nobody mentions any more is removed");

  // Signing out ends the session.
  ok((await auth("/sign-out", {}, granted.access_token)).status === 200, "the desktop signs out");
  ok((await call(granted.access_token, "/status")).status === 401, "and its token stops working");
} catch (err) {
  console.error(err);
  failures++;
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(state, { recursive: true, force: true });
  } catch {}
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
