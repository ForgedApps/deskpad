// Issue a device token by hand (step 1 of docs/sync-architecture.md; Better
// Auth replaces this later).
//
//   node scripts/issue-token.mjs <tenant> <device> [existing DEVICE_TOKENS json]
//
// Prints the token ONCE (paste it into Deskpad → Settings → Cloud sync on that
// device) and the new value for the DEVICE_TOKENS secret, which holds only the
// tokens' SHA-256 hashes. Pass the secret's current value as the third
// argument to add a device instead of replacing the table. Then:
//
//   npx wrangler secret put DEVICE_TOKENS        (paste the printed JSON)
//
// A tenant id names that tenant's Durable Object and R2 prefix forever: pick
// it once, never reuse it for someone else.

import { createHash, randomBytes } from "node:crypto";

const [tenant, device, existing] = process.argv.slice(2);
if (!/^[a-z0-9_-]{3,64}$/.test(tenant ?? "") || !/^[A-Za-z0-9_-]{1,64}$/.test(device ?? "")) {
  console.error("usage: node scripts/issue-token.mjs <tenant: a-z 0-9 _ -, 3-64 chars> <device: letters, digits, _ -> [existing json]");
  process.exit(1);
}
let table = {};
if (existing) {
  try {
    table = JSON.parse(existing);
  } catch {
    console.error("the third argument is not valid JSON");
    process.exit(1);
  }
}
const token = randomBytes(32).toString("base64url");
table[createHash("sha256").update(token).digest("hex")] = { tenant, device };

console.log(`Device token for ${device} (shown once, keep it private):\n\n  ${token}\n`);
console.log(`DEVICE_TOKENS secret (hashes only):\n\n${JSON.stringify(table)}\n`);
