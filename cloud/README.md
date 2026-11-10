# Deskpad cloud

The sync API from [docs/sync-architecture.md](../docs/sync-architecture.md): one
Worker, one SQLite-backed Durable Object per tenant (`TenantDO`), images in R2
under `t/<tenant>/img/`. The tenant always comes from the caller's token.

## Local

```
npm install
npm test              # Worker against wrangler dev: sync, accounts, device flow, tenant isolation
npm run test:desktop  # the desktop's Rust sync engine against wrangler dev
npm run dev           # http://127.0.0.1:8787: the API and the web app, secrets from .dev.vars
```

`.dev.vars` (not committed) needs `BETTER_AUTH_SECRET` and `ADMIN_KEY`; then
create the tables once:

```
curl -X POST -H "x-admin-key: <ADMIN_KEY>" http://127.0.0.1:8787/api/admin/migrate
```

`public/` is build output: `npm run build:web` at the repository root builds
`web/` into it (the `dev`, `test` and `deploy` scripts do that first).

## Deploy (once per environment)

```
npx wrangler login
npx wrangler r2 bucket create deskpad-files
npx wrangler d1 create deskpad-accounts            # put the id in wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET         # 32+ random bytes
npx wrangler secret put ADMIN_KEY                  # 24+ random characters
npm run deploy
curl -X POST -H "x-admin-key: <ADMIN_KEY>" https://<worker>/api/admin/migrate
```

Run the migrate call again after any deploy that changes Better Auth's
configuration. Then open the Worker's address and create the first account;
with `SIGNUP` at `first` (the default) nobody else can sign up afterwards.

Optional Google sign-in: create a **web** OAuth client with the redirect
`https://<worker>/api/auth/callback/google` and set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` as secrets.

`npm run deploy -- --env staging` is not wired; use
`wrangler deploy --env staging` after `npm run build:web`. Staging has its own
Worker, Durable Object namespace, bucket and database, so test tenants never
share storage with real ones.

`DEVICE_TOKENS` (see `scripts/issue-token.mjs`) is an optional second way to
authenticate, for tests and automation only. Do not set it in production.

## Endpoints

| | |
| --- | --- |
| `/api/auth/*` | Better Auth: sign-in, sign-up, sessions, the device flow |
| `POST /api/v1/sync` | push changed rows and days, pull everything after `since` |
| `GET /api/v1/export` | everything the tenant has, as JSON |
| `GET /api/v1/status` | tenant, device, account and counts; no content |
| `PUT/GET/HEAD /api/v1/images/<name>` | content-addressed pictures |
| `GET /api/v1/health`, `/api/v1/auth-methods` | unauthenticated |
| `POST /api/admin/migrate` | create or update control-plane tables (`x-admin-key`) |
| `/`, `/device` | the web app; the sign-in and device approval page |
