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
- A control plane (accounts, devices, tokens) that can grow a sign-up flow,
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
| Control plane | One **D1** database (`accounts`) | Users, tenants, memberships, devices, tokens. Small, relational, easy to inspect. Holds no note content. |
| API and auth | One **Worker** | The only thing with bindings to the DO namespace, R2 and D1. Validates tokens, resolves the tenant, forwards to that tenant's DO. |
| Static mobile app | Worker **static assets** | Same Worker serves the PWA, so API and app share an origin and cookies work. |
| Background jobs | **Queues** + **Cron Triggers** | Nightly snapshot export per tenant to R2, tombstone GC, orphan image sweep. |

Rejected: Workers KV for content (eventually consistent, no queries), a shared
D1 database for everyone's rows (isolation by convention only), Cloudflare
Access as the user directory (fine for one person, priced per seat and not a
public sign-up).

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

```sql
CREATE TABLE users      (id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at INTEGER, status TEXT);
CREATE TABLE tenants    (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, plan TEXT, status TEXT);
CREATE TABLE memberships(user_id TEXT, tenant_id TEXT, role TEXT, PRIMARY KEY (user_id, tenant_id));
CREATE TABLE devices    (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, name TEXT, kind TEXT,
                         created_at INTEGER, last_seen INTEGER, revoked_at INTEGER);
CREATE TABLE tokens     (hash TEXT PRIMARY KEY, device_id TEXT, expires_at INTEGER, scopes TEXT);
CREATE TABLE usage      (tenant_id TEXT, day TEXT, rows INTEGER, bytes INTEGER, images INTEGER,
                         PRIMARY KEY (tenant_id, day));
```

A user has memberships in tenants; today every user gets exactly one tenant at
sign-up and is its owner. Keeping the three tables apart from day one is what
makes shared workspaces possible later without a migration of content.

Ids are ULIDs (sortable, 26 chars). Tokens are random 256-bit values; only
their SHA-256 is stored.

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

Today: one person, so the first implementation is **sign-in with Google (OIDC)
in the Worker**, which the user already has and which the PWA needs anyway.
Passkeys can be added as a second method later; email magic links need an email
provider and wait for the sign-up work.

- Browser sessions (PWA): an HttpOnly, `SameSite=Lax` cookie carrying a session
  token; the Worker looks it up in `tokens` and gets `device`, `user`, `tenant`.
- Desktop: a **device authorization** flow. The app opens the browser at
  `/link?code=…`, the user signs in there and approves the device, and the app
  polls until it receives a long-lived device token (90 days, rotated on use).
  This reuses the loopback trick `google.rs` already does for Google.
- Tokens carry scopes (`sync`, `images`, `export`); revoking a device deletes
  its tokens, and the DO drops that device's WebSocket on the next message.
- Memberships gate tenant access. Today `role = owner` for everyone; the
  check is written as "has a membership with a role that allows X" from the
  start so sharing is an insert, not a code change.

Secrets (`OIDC client secret`, token signing key) live in Worker secrets, never
in the repo. The desktop app only ever holds its own device token.

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
    auth/                 # OIDC, device link flow, token store
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
3. Worker auth: Google OIDC, device link flow, D1 control plane with one user
   and one tenant created by a script.
4. PWA: mobile layout over the shared outline code, IndexedDB store.
5. Sign-up page, email, billing: new code in `auth/` and the website, no change
   below the Worker's auth middleware.
