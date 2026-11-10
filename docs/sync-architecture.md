# Deskpad cloud: sync, backup and multi-tenancy

Status: design only. Nothing in this document is built yet. It describes the
infrastructure Deskpad will sync through so that a later public sign-up
("Deskpad is a note and calendar app for Windows and mobile") can be added
without reworking storage, and so that one tenant's data can never be read or
written by another.

The desktop app stays local-first: `tasks.json` and friends remain the working
copy, the app keeps working offline, and the cloud is a replica that other
devices (a mobile web app) sync with.

## 1. Goals and non-goals

Goals

- Remote backup of every tenant's outline, archive, day events and images.
- Two-way sync between a tenant's devices (Windows app, mobile PWA) with
  row-level merging, so edits on two devices don't clobber each other.
- Hard tenant isolation: no shared table, bucket key space or cache that a bug
  in a query could cross. Isolation should come from the platform's object
  boundaries, not from a `WHERE tenant_id = ?` clause.
- Cheap at one user, and no redesign at ten thousand.
- A control plane (accounts, tenants, sessions) that can grow a sign-up flow,
  sharing and billing later without touching the data plane.

Non-goals for now

- The marketing site, sign-up UI, billing and email. Only the hooks for them.
- Real-time collaborative editing between people. Tenants are one person (or
  later one workspace) with several devices.
- Moving Google Calendar auth into the cloud. The desktop keeps its OAuth
  tokens locally; see §9 for the later option.

## 2. Platform choices (Cloudflare)

| Concern | Choice | Why |
| --- | --- | --- |
| Per-tenant data | One **Durable Object** (SQLite-backed) per tenant | Each DO has its own SQLite database; there is no table that holds two tenants. Strong consistency, transactions, WebSockets for live push, point-in-time recovery built in. |
| Images and exports | One **R2** bucket, keys prefixed `t/<tenant>/…`, never public | Objects are only ever read or written by the Worker after it has resolved the tenant from the caller's token. Bucket-per-tenant is kept as an option for a future "enterprise" tier. |
| Control plane | One **D1** database (`accounts`) | Better Auth's tables (users, sessions, organizations, members) plus usage. Small, relational, easy to inspect. Holds no note content. |
| API and auth | One **Worker** | The only thing with bindings to the DO namespace, R2 and D1. Validates sessions, resolves the tenant, forwards to that tenant's DO. |
| Static mobile app | Worker **static assets** | Same Worker serves the PWA, so API and app share an origin and cookies work. |
| Background jobs | **Queues** + **Cron Triggers** | Nightly snapshot export per tenant to R2, tombstone GC, orphan image sweep. |

| Identity | **Better Auth** in the Worker, on the D1 control plane | Owns users, sessions and sign-in methods in our own database; its organization plugin is the tenant/membership model. See §6. |

Rejected: Workers KV for content (eventually consistent, no queries) and a
shared D1 database for everyone's rows (isolation by convention only).

On Cloudflare Access: it would protect the API perfectly well while Deskpad
has one user, and it is free for up to 50 seats. It is not the user directory
for a public product, for reasons that have nothing to do with the Workers
plan (Access is billed separately, per seat, under Zero Trust): every customer
would be a seat in our Zero Trust organization, there is no self-serve sign-up
or account we own (only the identity provider's claims), and the desktop app
would need admin-issued service tokens rather than a per-user device login.
Access stays useful for what it is built for: gating `staging` and any admin
endpoints to the team.

## 3. Isolation model

Every request follows the same path and there is exactly one place where the
tenant is decided:

```
client ──token──▶ Worker: authenticate(token) → { user, device, tenant }
                   │
                   ├─▶ env.TENANT.idFromName(tenant.id).fetch(req)   (DO)
                   └─▶ env.FILES.get(`t/${tenant.id}/img/${hash}`)   (R2)
```

Rules that make this hold:

1. **The tenant id comes only from the authenticated token**, never from a URL,
   body or header the client controls. The Worker rewrites the request it
   sends to the DO so the DO can't be addressed any other way.
2. **The DO is named by tenant id** (`idFromName`), so there is one object per
   tenant and no way to reach another tenant's object without its id, which
   only the Worker knows and only derives from a token.
3. **The DO trusts its own identity, not the request.** It stores its tenant id
   on first use and rejects any request whose internal header disagrees, as a
   belt-and-braces check against a Worker bug.
4. **R2 keys are built by the Worker from the resolved tenant**; client-supplied
   names are validated against `^[0-9a-f]{20}\.(png|jpg|gif|webp|svg)$` and
   appended, never joined as paths. The bucket is private; reads go through the
   Worker (or short-lived signed URLs the Worker issues, if the PWA needs
   direct loads).
5. **No cross-tenant jobs run inside a DO.** Nightly exports and GC are driven
   by a cron Worker that lists tenants from D1 and calls each DO in turn; a DO
   only ever touches its own storage and its own R2 prefix.
6. **Caches are keyed by tenant.** The Worker sets `Cache-Control: private` on
   everything under `/api/`; nothing tenant-specific is cached at the edge.
7. **Logs never contain row text or image bytes**, only ids, counts and sizes.

Deleting a tenant is therefore mechanical: `storage.deleteAll()` on its DO, a
prefix delete on R2, and the rows in D1. There is nothing else to find.

## 4. Data model

### 4.1 Control plane (D1 `accounts`)

Better Auth generates and migrates its own tables in this database (`user`,
`session`, `account`, `verification`, and with the organization plugin
`organization`, `member`, `invitation`). We don't hand-roll those. The mapping
to this design:

| Concept here | Better Auth table | Notes |
| --- | --- | --- |
| User | `user` | Plus `account` rows per sign-in method (Google, passkey, …). |
| Tenant | `organization` | Its `id` is the tenant id that names the Durable Object and the R2 prefix. Extra fields: `plan`, `status`. |
| Membership | `member` | `role` = owner today; admin/member later for shared workspaces. |
| Device / token | `session` | One session per device, with `activeOrganizationId` selecting the tenant. Extra fields: device `name`, `kind` (windows, web). |

Our own tables alongside:

```sql
CREATE TABLE usage (tenant_id TEXT, day TEXT, rows INTEGER, bytes INTEGER, images INTEGER,
                    PRIMARY KEY (tenant_id, day));
```

A user has memberships in organizations; today a database hook creates exactly
one organization per new user and makes them its owner. Keeping user, tenant
and membership apart from day one is what makes shared workspaces possible
later without a migration of content.

The tenant id must be treated as permanent and unguessable-by-construction is
not required (isolation never depends on the id being secret), but it must
never be reused: a deleted organization's id is tombstoned in a small
`retired_tenants` table so a new tenant can't inherit an old object or prefix.

### 4.2 Data plane (one Durable Object per tenant, SQLite)

```sql
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);          -- tenant_id, schema_version, seq
CREATE TABLE rows  (
  id          TEXT PRIMARY KEY,   -- client-generated, see §5.1
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- note | task
  done        INTEGER NOT NULL,
  parent      TEXT,
  rank        TEXT NOT NULL,      -- order among siblings, see §5.2
  created_at  INTEGER NOT NULL,
  done_at     INTEGER,
  schedule    TEXT,               -- JSON {start,end,all_day,event_id} or NULL
  archived_at INTEGER,            -- NULL while in the outline
  updated_at  INTEGER NOT NULL,   -- HLC, see §5.3
  updated_by  TEXT NOT NULL,      -- device id
  deleted     INTEGER NOT NULL,   -- tombstone
  seq         INTEGER NOT NULL    -- server change number, monotonic per tenant
);
CREATE INDEX rows_seq ON rows(seq);
CREATE TABLE day_events (day TEXT PRIMARY KEY, events TEXT NOT NULL, updated_at INTEGER, seq INTEGER);
CREATE TABLE images (hash TEXT PRIMARY KEY, ext TEXT, bytes INTEGER, created_at INTEGER, last_ref INTEGER);
```

This mirrors `Item` in `store.rs` plus the sync columns. The outline and the
archive are one table distinguished by `archived_at`, which is what the journal
already treats them as.

Settings stay local. `settings.json` holds the Google OAuth client and
preferences that are per machine; `google_tokens.json` never leaves the device.

### 4.3 Images (R2)

Key: `t/<tenant>/img/<sha256 prefix>.<ext>`, the same name the desktop already
derives in `save_image`, so a row's `![](img:<name>)` marker means the same
file on every device. Content-addressed keys make uploads idempotent and
de-duplicate across devices for free.

Exports: `t/<tenant>/export/<date>.json` (see §7).

## 5. Sync protocol

### 5.1 Row ids

Today the frontend mints ids from the clock, which two devices could collide
on. New rows get a random 128-bit id encoded as 22 base64url chars (or a ULID);
existing numeric ids are kept as their decimal string on first upload. `Item.id`
becomes a string on both sides; the JSON files migrate on load.

### 5.2 Ordering

`tasks.json` is kept in pre-order and the order of siblings is positional. That
doesn't merge: two devices inserting under the same parent need an order that
survives concurrent edits. Each row carries a `rank`, a fractional index string
(e.g. the `fractional-indexing` scheme) among its siblings. The desktop keeps
its pre-order list as the view; `normalize` sorts siblings by `rank` after a
pull, and a local move assigns a new rank between its new neighbours.

### 5.3 Clocks and conflicts

`updated_at` is a hybrid logical clock (wall ms ⊕ counter, per device) so
ordering is sane across devices with skewed clocks. Merge rule, per row, per
field group: **last writer wins on `updated_at`**, with the device id as the
tiebreak. Tasks are small and single-person, so field-level merging isn't worth
its complexity; the one exception is `done`/`done_at`, which wins if either
side completed the task after the other side's last edit.

Deletes are tombstones (`deleted = 1`, text cleared). Archiving is not a
delete; it sets `archived_at` and syncs like any edit. Tombstones older than 90
days are purged by the GC job once every device of the tenant has acknowledged
a `seq` past them.

### 5.4 Operations

All under `/api/v1/`, JSON, bearer token.

| Call | Purpose |
| --- | --- |
| `POST /sync` `{ since, changes[], device }` | Push local changes and pull everything with `seq > since` in one round trip. Returns `{ seq, rows[], day_events[], rejected[] }`. The DO applies the merge rule, assigns `seq` to accepted rows, and the client overwrites its local copies with what the server returns (so both sides converge on the same bytes). |
| `GET /sync/stream` (WebSocket) | The DO pushes `{ seq }` whenever another device wrote; the client then calls `/sync`. Hibernatable WebSockets so idle tenants cost nothing. |
| `PUT /images/<name>` (raw body) | Store an image if absent; the Worker checks the name against the body's hash before writing to R2. |
| `GET /images/<name>` | Read through the Worker with the tenant's prefix. |
| `GET /export` | Full JSON snapshot (rows, day events, image names); what the desktop would use to recover a machine. |
| `DELETE /tenant` | Wipe (owner only, confirmed by a second factor later). |

The pre-order invariant and `normalize` keep working locally; the server stores
the tree, not the order of the file.

### 5.5 Client side (desktop)

A `sync.rs` module next to `store.rs`:

- A device id and token in `cloud.json` (same folder, never synced).
- An outbox: `Store` marks rows dirty on every write (`set_items` diffs against
  the previous list, since the frontend sends whole lists today). The outbox
  is flushed on a debounce, on launch, and when the WebSocket says there is
  news; failures retry with backoff. Offline is the normal state, not an error.
- Pulls apply through the same `normalize` path as a restore and then emit
  `items-changed`, which the sidebar and journal already listen to.
- Images: `save_image` enqueues an upload after writing locally; a row whose
  image hasn't been uploaded yet still syncs (the marker is text), and the
  other device shows the existing "missing picture" placeholder until the
  upload lands.

The mobile PWA uses the same protocol from TypeScript with an IndexedDB copy of
the rows, so the shared outline code sees one `Backend` interface with two
implementations (`invoke` on desktop, `fetch` + IndexedDB on the web).

## 6. Authentication and devices

**Better Auth** runs inside the Worker, mounted at `/api/auth/*`, with the D1
`accounts` database as its store (Kysely D1 dialect or Drizzle). It is a
library, not a service: users and sessions live in our database, there is no
per-seat fee, and sign-up later is configuration plus a page rather than a
migration to a different identity system.

Configuration, in the order it gets switched on:

1. **Google as a social provider.** One person today, and the PWA needs a
   browser sign-in anyway. Sign-up is closed by an allowlist of emails in a
   `before` hook until the public launch; opening it is deleting the hook.
2. **Organization plugin** for tenants and memberships (§4.1). A `user.create`
   database hook creates the user's personal organization; `session.create`
   sets it active.
3. **Device authorization plugin** (RFC 8628) for the desktop. The app asks
   for a code, opens the browser at the verification page, the user signs in
   and approves, and the app polls until it receives a session token, which it
   stores in `cloud.json` and sends as a bearer token (bearer plugin). No
   loopback listener or embedded secret is needed, and the same flow works for
   any future native client.
4. **Passkeys**, then **email + magic link** when there is an email provider
   and a sign-up page. Both are plugins over the same tables.

How a request is authorized:

- The Worker's middleware calls `auth.api.getSession({ headers })`. That
  accepts the PWA's HttpOnly cookie or the desktop's bearer token and returns
  `{ user, session }`.
- The tenant is `session.activeOrganizationId`, and the middleware confirms a
  `member` row for (user, organization) on every request, cached for a minute
  per session. That pair is the only input to `idFromName` and to the R2
  prefix (§3 rule 1). Better Auth never sees or addresses a Durable Object.
- Revoking a device is deleting its session; the DO drops that device's
  WebSocket on its next message because the Worker re-checks the session when
  it upgrades and on a timer.
- Role checks are written as "has a membership with a role that allows X" from
  the start, using the organization plugin's access control, so sharing is an
  insert, not a code change.

Things to pin down when building, because they are easy to get wrong on
Workers:

- Create the `betterAuth` instance per request (or per isolate with the D1
  binding passed in), since bindings only exist inside the handler.
- Session lookups hit D1 on every API call. Enable Better Auth's cookie cache
  for the PWA and keep a short in-isolate cache for bearer tokens; do not put
  sessions in KV as the source of truth (revocation would lag).
- `BETTER_AUTH_SECRET` and the Google client secret are Worker secrets, per
  environment, never in the repo. The desktop holds only its own session token.
- The WebSocket upgrade (`/sync/stream`) cannot send an Authorization header
  from a browser; the PWA relies on the cookie, and the desktop passes the
  token in the `Sec-WebSocket-Protocol` header, never in the URL.

Cloudflare Access is still used, but only around `staging` and admin routes.

## 7. Backup, export and recovery

Three layers, cheapest first:

1. **Local**: `backups\` daily copies stay as they are.
2. **Durable Object point-in-time recovery**: SQLite-backed DOs keep 30 days of
   history; a tenant can be rolled back to any bookmark with no extra code.
3. **Nightly export to R2**: a cron Worker asks each DO for `/export` and writes
   `t/<tenant>/export/<date>.json` (and images are already content-addressed
   in the same bucket). R2 object lifecycle rules keep 90 days. This is the
   copy that survives a DO deletion mistake and is the user-visible "download
   my data" artifact.

Recovering a new PC is "sign in, let it pull"; recovering from a bad edit is
"restore yesterday's export" (an endpoint that loads an export into the DO as
new versions of every row, so it syncs out to the other devices like any edit).

## 8. Quotas, abuse and cost

- Per-tenant limits enforced inside the DO (it is the only writer): rows,
  bytes of text, number and total size of images. Free tier numbers can be
  generous (say 50k rows, 1 GB of images) and are read from `tenants.plan`.
- The Worker applies a rate limit per token (Workers rate-limiting binding)
  and rejects image bodies over 10 MB before touching R2.
- Hibernatable WebSockets and alarm-driven GC mean an idle tenant costs
  nothing; an active one is a few thousand requests a day, well inside the
  paid Workers plan's included usage. R2 has no egress charge, which is what
  makes "every device pulls images" affordable.

## 9. Later: calendar in the cloud

The desktop keeps its own Google tokens, so meetings and alerts never depend
on the cloud. If the PWA should show the calendar too, the cleanest route is a
second OAuth grant stored **in the tenant's DO** (encrypted with a per-tenant
key derived from a Worker secret), with the Worker fetching events for the
phone. `calendar.rs` and `google.rs` would gain a sibling implementation in
TypeScript rather than being moved. Nothing in §3–§7 changes for this.

## 10. Repository layout and environments

```
cloud/
  wrangler.jsonc          # worker + DO namespace + R2 + D1 + queue bindings, per-env
  src/
    index.ts              # router, auth middleware, static assets fallthrough
    auth/                 # Better Auth config (providers, organization, device flow), tenant middleware
    tenant-do.ts          # Durable Object: schema, /sync, /export, websockets, alarms
    images.ts             # R2 put/get with tenant prefix
    jobs/                 # cron: exports, tombstone GC, orphan image sweep
  migrations/             # D1 control-plane migrations
  test/                   # vitest-pool-workers: merge rules, isolation tests
shared/
  protocol.ts             # request/response types, merge rules, HLC, rank helpers
                          # imported by cloud/, src/ (PWA) and mirrored in sync.rs
```

Environments: `dev` (local `wrangler dev` with Miniflare, a throwaway D1 and
R2), `staging`, `prod`, each with its own DO namespace and bucket so a test
tenant can never land in the production bucket. The desktop reads its API base
from `cloud.json` so a dev build can point at staging.

Isolation is tested, not assumed: the test suite creates two tenants, writes to
both, and asserts that every endpoint called with tenant A's token returns
only A's rows and images, including after deleting B.

## 11. Order of work

1. `shared/protocol.ts` + the DO with `/sync` and `/export`; string ids,
   `rank`, HLC on the desktop; `sync.rs` with a hard-coded single tenant and a
   device token issued by hand. This already gives remote backup and
   two-machine sync.
2. Images through R2; nightly export job; PITR tested.
3. Worker auth: Better Auth on D1 with Google sign-in (allowlisted), the
   organization plugin, and the device authorization flow for the desktop.
4. PWA: mobile layout over the shared outline code, IndexedDB store.
5. Sign-up page, email, billing: remove the allowlist, add the email and
   passkey plugins and the website. No change below the Worker's auth
   middleware.
