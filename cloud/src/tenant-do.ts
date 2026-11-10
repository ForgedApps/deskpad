// One Durable Object per tenant. It owns that tenant's rows in its own SQLite
// database, so there is no table anywhere that holds two tenants' content. It
// is only ever reached through the Worker, which derives the tenant from the
// caller's credentials (see index.ts); the object also remembers whose it is
// and refuses a call made in another tenant's name.

import { DurableObject } from "cloudflare:workers";
import { newer, PAGE, type ExportResponse, type SyncRequest, type SyncResponse, type WireDay, type WireRow } from "../../shared/protocol";

type Sql = string | number | null;

interface RowRec extends Record<string, SqlStorageValue> {
  id: string;
  text: string;
  kind: string;
  done: number;
  parent: string | null;
  rank: string;
  created_at: number;
  done_at: number | null;
  schedule: string | null;
  archived_at: number | null;
  updated_at: number;
  updated_by: string;
  deleted: number;
  seq: number;
}

interface DayRec extends Record<string, SqlStorageValue> {
  day: string;
  events: string;
  updated_at: number;
  updated_by: string;
  seq: number;
}

const MAX_TEXT = 20_000;
const MAX_ROWS = 200_000;

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        done INTEGER NOT NULL,
        parent TEXT,
        rank TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        done_at INTEGER,
        schedule TEXT,
        archived_at INTEGER,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rows_seq ON rows(seq);
      CREATE TABLE IF NOT EXISTS days (
        day TEXT PRIMARY KEY,
        events TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS days_seq ON days(seq);
    `);
  }

  private meta(key: string): string | null {
    const r = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return r.length ? r[0].value : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Bind this object to its tenant on first use; afterwards any other name is a bug upstream. */
  private claim(tenant: string) {
    const mine = this.meta("tenant");
    if (mine === null) this.setMeta("tenant", tenant);
    else if (mine !== tenant) throw new Error("tenant mismatch");
  }

  private seq(): number {
    return Number(this.meta("seq") ?? "0");
  }

  /** Push the caller's changes and return what it hasn't seen yet. */
  async sync(tenant: string, device: string, req: SyncRequest): Promise<SyncResponse> {
    this.claim(tenant);
    const since = Number.isFinite(req.since) && req.since > 0 ? Math.floor(req.since) : 0;
    // The server's copy of anything it refused, so the client can settle on it.
    const refusedRows: WireRow[] = [];
    const refusedDays: WireDay[] = [];

    this.ctx.storage.transactionSync(() => {
      let seq = this.seq();
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows").one().n;
      let added = 0;
      for (const raw of (req.rows ?? []).slice(0, PAGE)) {
        const row = cleanRow(raw, device);
        if (!row) continue;
        const cur = this.sql.exec<RowRec>("SELECT * FROM rows WHERE id = ?", row.id).toArray()[0];
        if (cur && !newer(row, cur)) {
          if (cur.seq <= since) refusedRows.push(toWire(cur));
          continue;
        }
        if (!cur && count + ++added > MAX_ROWS) continue;
        seq += 1;
        this.sql.exec(
          `INSERT INTO rows (id, text, kind, done, parent, rank, created_at, done_at, schedule, archived_at, updated_at, updated_by, deleted, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text, kind = excluded.kind, done = excluded.done, parent = excluded.parent,
             rank = excluded.rank, created_at = excluded.created_at, done_at = excluded.done_at, schedule = excluded.schedule,
             archived_at = excluded.archived_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
             deleted = excluded.deleted, seq = excluded.seq`,
          row.id, row.text, row.kind, row.done ? 1 : 0, row.parent, row.rank, row.created_at, row.done_at,
          row.schedule ? JSON.stringify(row.schedule) : null, row.archived_at, row.updated_at, row.updated_by, row.deleted ? 1 : 0, seq,
        );
      }
      for (const raw of (req.days ?? []).slice(0, PAGE)) {
        const day = cleanDay(raw, device);
        if (!day) continue;
        const cur = this.sql.exec<DayRec>("SELECT * FROM days WHERE day = ?", day.day).toArray()[0];
        if (cur && !newer(day, cur)) {
          if (cur.seq <= since) refusedDays.push(dayToWire(cur));
          continue;
        }
        seq += 1;
        this.sql.exec(
          `INSERT INTO days (day, events, updated_at, updated_by, seq) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET events = excluded.events, updated_at = excluded.updated_at, updated_by = excluded.updated_by, seq = excluded.seq`,
          day.day, JSON.stringify(day.events), day.updated_at, day.updated_by, seq,
        );
      }
      this.setMeta("seq", String(seq));
    });

    // One page of changes after `since`, rows and days interleaved by seq.
    const rows = this.sql.exec<RowRec>("SELECT * FROM rows WHERE seq > ? ORDER BY seq LIMIT ?", since, PAGE + 1).toArray();
    const days = this.sql.exec<DayRec>("SELECT * FROM days WHERE seq > ? ORDER BY seq LIMIT ?", since, PAGE + 1).toArray();
    const head = this.seq();
    let upto = head;
    let more = false;
    if (rows.length > PAGE || days.length > PAGE) {
      // Cut both lists at the same change number so nothing in between is skipped.
      more = true;
      upto = Math.min(rows.length > PAGE ? rows[PAGE - 1].seq : head, days.length > PAGE ? days[PAGE - 1].seq : head);
    }
    return {
      seq: upto,
      rows: [...rows.filter((r) => r.seq <= upto).map(toWire), ...refusedRows],
      days: [...days.filter((d) => d.seq <= upto).map(dayToWire), ...refusedDays],
      more,
    };
  }

  /** Everything this tenant has, for backups and for rebuilding a device. */
  async exportAll(tenant: string): Promise<ExportResponse> {
    this.claim(tenant);
    return {
      tenant,
      seq: this.seq(),
      exported_at: Date.now(),
      rows: this.sql.exec<RowRec>("SELECT * FROM rows ORDER BY seq").toArray().map(toWire),
      days: this.sql.exec<DayRec>("SELECT * FROM days ORDER BY day").toArray().map(dayToWire),
    };
  }

  /** Counts for the status endpoint; no content. */
  async stats(tenant: string): Promise<{ seq: number; rows: number; deleted: number; days: number }> {
    this.claim(tenant);
    const one = (q: string) => this.sql.exec<{ n: number }>(q).one().n;
    return {
      seq: this.seq(),
      rows: one("SELECT COUNT(*) AS n FROM rows WHERE deleted = 0"),
      deleted: one("SELECT COUNT(*) AS n FROM rows WHERE deleted = 1"),
      days: one("SELECT COUNT(*) AS n FROM days"),
    };
  }
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);
const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Validate a row from a client; the device is taken from the caller's credentials, never the body. */
function cleanRow(raw: WireRow, device: string): WireRow | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id, 40);
  const text = str(raw.text, MAX_TEXT);
  const updated_at = int(raw.updated_at);
  const created_at = int(raw.created_at);
  if (!id || !ID.test(id) || text === null || updated_at === null || created_at === null) return null;
  const parent = raw.parent === null || raw.parent === undefined ? null : str(raw.parent, 40);
  if (parent !== null && !ID.test(parent)) return null;
  let schedule: WireRow["schedule"] = null;
  if (raw.schedule && typeof raw.schedule === "object") {
    const start = int(raw.schedule.start);
    const end = int(raw.schedule.end);
    if (start !== null && end !== null) {
      schedule = { start, end, all_day: !!raw.schedule.all_day, event_id: str(raw.schedule.event_id, 1024) };
    }
  }
  return {
    id,
    text,
    kind: raw.kind === "task" ? "task" : "note",
    done: !!raw.done,
    parent: parent === id ? null : parent,
    rank: str(raw.rank, 200) ?? "",
    created_at,
    done_at: int(raw.done_at),
    schedule,
    archived_at: int(raw.archived_at),
    // A clock far in the future would win every later conflict; cap it.
    updated_at: Math.min(updated_at, Date.now() + 5 * 60_000),
    updated_by: device,
    deleted: !!raw.deleted,
  };
}

function cleanDay(raw: WireDay, device: string): WireDay | null {
  if (!raw || typeof raw !== "object") return null;
  const updated_at = int(raw.updated_at);
  if (typeof raw.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || updated_at === null || !Array.isArray(raw.events)) return null;
  if (JSON.stringify(raw.events).length > 200_000) return null;
  return { day: raw.day, events: raw.events, updated_at: Math.min(updated_at, Date.now() + 5 * 60_000), updated_by: device };
}

function toWire(r: RowRec): WireRow {
  return {
    id: r.id,
    text: r.text,
    kind: r.kind === "task" ? "task" : "note",
    done: r.done === 1,
    parent: r.parent,
    rank: r.rank,
    created_at: r.created_at,
    done_at: r.done_at,
    schedule: r.schedule ? JSON.parse(r.schedule) : null,
    archived_at: r.archived_at,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    deleted: r.deleted === 1,
    seq: r.seq,
  };
}

function dayToWire(d: DayRec): WireDay {
  return { day: d.day, events: JSON.parse(d.events), updated_at: d.updated_at, updated_by: d.updated_by, seq: d.seq };
}

export type { Sql };
