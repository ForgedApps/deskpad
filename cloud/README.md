# Deskpad cloud

The sync API from [docs/sync-architecture.md](../docs/sync-architecture.md): one
Worker, one SQLite-backed Durable Object per tenant (`TenantDO`), images in R2
under `t/<tenant>/img/`. The tenant always comes from the caller's token.

## Local

```
npm install
npm test              # 29 checks against wrangler dev: merge rules, images, tenant isolation
npm run test:desktop  # the desktop's Rust sync engine against wrangler dev
npm run dev           # http://127.0.0.1:8787, tokens from .dev.vars
```

`.dev.vars` (not committed) holds `DEVICE_TOKENS={...}`; make an entry with
`node scripts/issue-token.mjs dev pc-dev`.

## Deploy (once per environment)

```
npx wrangler login
npx wrangler r2 bucket create deskpad-files
npx wrangler deploy
node scripts/issue-token.mjs <tenant> <device>     # prints a token and the secret's JSON
npx wrangler secret put DEVICE_TOKENS              # paste the JSON
```

Then in Deskpad → Settings → Cloud sync, enter the Worker's `https://…workers.dev`
address and the token. Add a device by re-running `issue-token.mjs` with the
secret's current JSON as the third argument and putting the secret again.

`wrangler deploy --env staging` uses its own Worker, Durable Object namespace
and bucket (`deskpad-files-staging`), so test tenants never share storage with
real ones.

## Endpoints (`/api/v1`, bearer token)

| | |
| --- | --- |
| `POST /sync` | push changed rows and days, pull everything after `since` |
| `GET /export` | everything the tenant has, as JSON |
| `GET /status` | tenant, device and counts; no content |
| `PUT/GET/HEAD /images/<name>` | content-addressed pictures |
| `GET /health` | unauthenticated liveness |
