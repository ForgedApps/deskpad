// Runs the desktop sync engine (the ignored Rust test
// `engine_against_a_local_worker` in src-tauri/src/sync.rs) against a local
// `wrangler dev` with throwaway tokens and state: `npm run test:desktop` in cloud/.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8798;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const a = randomBytes(24).toString("hex");
const b = randomBytes(24).toString("hex");
const state = mkdtempSync(join(tmpdir(), "deskpad-desktop-e2e-"));
const vars = join(state, "vars");
writeFileSync(vars, `DEVICE_TOKENS=${JSON.stringify({ [sha(a)]: { tenant: "e2e", device: "pc-a" }, [sha(b)]: { tenant: "e2e", device: "pc-b" } })}\n`);

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", join(state, "persist"), "--env-file", vars, "--show-interactive-dev-session=false"], { cwd: root, shell: true, stdio: "ignore" });
const stop = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
};

let code = 1;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`http://127.0.0.1:${PORT}/api/v1/status`, { headers: { authorization: `Bearer ${a}` } }).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error("the local Worker did not start, or another server holds the port");
  const run = spawnSync("cargo", ["test", "engine_against_a_local_worker", "--", "--ignored", "--nocapture"], {
    cwd: join(root, "..", "src-tauri"),
    stdio: "inherit",
    env: { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}`, DESKPAD_SYNC_URL: `http://127.0.0.1:${PORT}`, DESKPAD_SYNC_TOKEN_A: a, DESKPAD_SYNC_TOKEN_B: b },
  });
  code = run.status ?? 1;
} catch (err) {
  console.error(err);
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  try {
    rmSync(state, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
