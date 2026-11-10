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
configuration. Then set up Google sign-in (below) and sign in: with `SIGNUP`
at `first` (the default) the first Google account to sign in owns the server
and nobody else can create one afterwards. Set it to `open` for a public
launch.

## Google sign-in (the only way in)

"Continue with Google" signs a person in, or creates their account if they
have none, and the same consent grants the Calendar access the apps use. It
needs one OAuth client of type **Web application**. The desktop app's older
"Desktop app" client is a different thing and cannot be reused here.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Pick a project (the one that already has the Calendar API is fine) and make
   sure **Google Calendar API** is enabled under APIs & Services → Library.
2. **Google Auth Platform → Branding**: app name "Deskpad", your support email.
3. **Audience**: user type External. Press **Publish app** so the status reads
   "In production". Left in "Testing", Google expires the calendar grant
   every 7 days and only listed test users can sign in.
4. **Data Access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/calendar.readonly` and
   `https://www.googleapis.com/auth/calendar.events` (plus the default
   `openid`, `userinfo.email`, `userinfo.profile`).
5. **Clients → Create client → Web application**:
   - Authorized JavaScript origins: `https://<worker>` (for example
     `https://deskpad-cloud.jgentes.workers.dev`)
   - Authorized redirect URIs: `https://<worker>/api/auth/callback/google`
6. Copy the client ID and secret into the Worker:

```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Secrets take effect at once; no deploy is needed. Until Google has verified
the app, the consent screen says "Google hasn't verified this app": choose
Advanced, then "Go to Deskpad". That is fine for personal use (up to 100
accounts). A public launch needs Google's verification for the two calendar
scopes, which are classed as sensitive.

On the consent screen, leave both calendar boxes ticked. Without them sign-in
still works and notes sync, but the apps show no calendar and say why.

`npm run deploy -- --env staging` is not wired; use
`wrangler deploy --env staging` after `npm run build:web`. Staging has its own
Worker, Durable Object namespace, bucket and database, so test tenants never
share storage with real ones.

`DEVICE_TOKENS` (see `scripts/issue-token.mjs`) and `ALLOW_PASSWORD=1` (email
and password accounts) exist for the automated tests only. Do not set either
in production.

## Endpoints

| | |
| --- | --- |
| `/api/auth/*` | Better Auth: sign-in, sign-up, sessions, the device flow |
| `POST /api/v1/sync` | push changed rows and days, pull everything after `since` |
| `GET /api/v1/export` | everything the tenant has, as JSON |
| `GET /api/v1/status` | tenant, device, account and counts; no content |
| `GET /api/v1/google-token` | a current Google access token for the signed-in account, and whether it covers the calendar |
| `PUT/GET/HEAD /api/v1/images/<name>` | content-addressed pictures |
| `GET /api/v1/health`, `/api/v1/auth-methods` | unauthenticated |
| `POST /api/admin/migrate` | create or update control-plane tables (`x-admin-key`) |
| `/`, `/device` | the web app; the sign-in and device approval page |
