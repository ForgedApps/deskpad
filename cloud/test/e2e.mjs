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

  // The desktop's sign-in: device code, approval in the browser, token.
  const dc = await (await auth("/device/code", { client_id: "deskpad-desktop" })).json();
  ok(!!dc.device_code && !!dc.user_code && String(dc.verification_uri_complete).includes("/device?user_code="), "the desktop gets a device code and a page to open");
  ok((await auth("/device/code", { client_id: "someone-else" })).status === 400, "other clients cannot start a device sign-in");
  const poll = () => auth("/device/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code, client_id: "deskpad-desktop" });
  const pending = await poll();
  ok(pending.status === 400 && (await pending.json()).error === "authorization_pending", "polling before approval says pending");
  ok((await auth("/device/approve", { userCode: dc.user_code })).status !== 200, "nobody can approve without being signed in");
  ok((await auth(`/device?user_code=${dc.user_code}`, undefined, web)).status === 200, "the signed-in browser claims the code");
  ok((await auth("/device/approve", { userCode: dc.user_code }, web)).status === 200, "and approves it");
  await new Promise((r) => setTimeout(r, 3500));
  const granted = await (await poll()).json();
  ok(typeof granted.access_token === "string" && granted.access_token.length >= 32, "the desktop receives its own session token");
  const dst = await (await call(granted.access_token, "/status")).json();
  ok(dst.tenant === ownerTenant && dst.device !== st.device, "the desktop lands in the same tenant as a separate device");
  r = await sync(granted.access_token, 0, [row("900", "from the desktop", Date.now())]);
  ok(r.rows.length === 1, "the desktop session can sync");
  r = await sync(web, 0);
  ok(r.rows.length === 1 && r.rows[0].text === "from the desktop", "the browser session sees the desktop's row");
  ok((await sync(tok.a1, 0)).rows.every((x) => x.text !== "from the desktop"), "token tenant A still sees none of the account's rows");

  // Cookie sessions must not accept cross-site writes.
  const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0];
  const body = JSON.stringify({ since: 0, rows: [], days: [] });
  const xs = await fetch(`${BASE}/sync`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body });
  ok(xs.status === 403, "a cross-site POST with the session cookie is refused");
  const same = await fetch(`${BASE}/sync`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body });
  ok(same.status === 200, "the same POST from our own origin works with the cookie");

  // Google is the only sign-in offered; here it isn't configured, and a password account has no Google grant.
  ok((await (await fetch(`${BASE}/auth-methods`)).json()).google === true, "auth-methods reports that Google sign-in is set up");
  const social = await (await auth("/sign-in/social", { provider: "google", callbackURL: "/device?user_code=ABCD", errorCallbackURL: "/device" })).json();
  const g = new URL(social.url ?? "http://invalid");
  const scope = g.searchParams.get("scope") ?? "";
  ok(g.hostname === "accounts.google.com" && g.searchParams.get("client_id") === "test-client.apps.googleusercontent.com", "Continue with Google sends the browser to Google with our client");
  ok(g.searchParams.get("redirect_uri") === `${ORIGIN}/api/auth/callback/google`, "the redirect is this server's callback");
  ok(scope.includes("calendar.readonly") && scope.includes("calendar.events") && scope.includes("email"), "one consent asks for sign-in and the calendar");
  ok(g.searchParams.get("access_type") === "offline" && (g.searchParams.get("prompt") ?? "").includes("consent"), "and for a refresh token every time");
  ok((await call(web, "/google-token")).status === 404, "an account without a Google grant has no calendar token");
  ok((await call(tok.a1, "/google-token")).status === 404, "nor does a test token");

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
