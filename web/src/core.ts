// The sync logic of the web app, as pure functions: sibling ranks, pre-order,
// the three-way merge of the outline's whole-list save, and the push/pull
// merge with the server. It is the TypeScript twin of `rank.rs`, `normalize`
// and `set_from_frontend` in `store.rs`, and `plan_rows` / `apply_rows` in
// `sync.rs`; change them together. Nothing here touches the DOM, storage or
// the network, so `web/test/core.test.ts` runs it in Node.

import type { ArchivedItem, Item } from "../../src/outline";
import type { WireRow } from "../../shared/protocol";

export const PAGE = 2000;

// ---------- ranks (rank.rs) ----------

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62;
const HEAD = 6;
const STEP = BASE ** 3;
const HEAD_MAX = BASE ** HEAD;

const val = (c: string | undefined) => (c === undefined ? 0 : Math.max(0, DIGITS.indexOf(c)));

export function validRank(rank: string | undefined): rank is string {
  if (!rank || rank.length > 200 || rank.endsWith("0")) return false;
  for (const c of rank) if (!DIGITS.includes(c)) return false;
  return true;
}

function head(rank: string): number {
  let n = 0;
  for (let i = 0; i < HEAD; i++) n = n * BASE + val(rank[i]);
  return n;
}

function encode(n: number): string {
  let out = "";
  for (let i = 0; i < HEAD; i++) {
    out = DIGITS[n % BASE] + out;
    n = Math.floor(n / BASE);
  }
  return out.replace(/0+$/, "");
}

/** A string strictly between `a` and `b` (`a < b`; "" is the lower bound, null the upper). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = val(a[0]);
  const db = b !== null && b.length ? val(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.floor((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/** A rank between two neighbours; null means no neighbour on that side. */
export function between(a: string | null, b: string | null): string {
  if (a === null && b === null) return encode(HEAD_MAX / 2);
  if (b === null) {
    const n = head(a!) + STEP;
    return n < HEAD_MAX ? encode(n) : midpoint(a!, null);
  }
  if (a === null) {
    const n = head(b);
    return n > STEP ? encode(n - STEP) : midpoint("", b);
  }
  return midpoint(a, b);
}

/** Indices of a longest strictly increasing run of valid ranks. */
function keepers(ranks: (string | undefined)[]): number[] {
  const tails: number[] = [];
  const prev: (number | null)[] = ranks.map(() => null);
  ranks.forEach((r, i) => {
    if (!validRank(r)) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ranks[tails[mid]] as string) < r) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : null;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let at: number | null = tails.length ? tails[tails.length - 1] : null; at !== null; at = prev[at]) out.push(at);
  return out.reverse();
}

function fill(lo: string | null, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (hi === null) {
    const out: string[] = [];
    let last = lo;
    for (let i = 0; i < n; i++) {
      last = between(last, null);
      out.push(last);
    }
    return out;
  }
  const mid = Math.floor(n / 2);
  const m = between(lo, hi);
  return [...fill(lo, m, mid), m, ...fill(m, hi, n - mid - 1)];
}

/** Make every sibling group's ranks strictly increasing in list order, giving
 *  new ranks only to rows that have none or sit out of order. */
export function repairRanks(items: Item[]): boolean {
  const groups = new Map<number | null, number[]>();
  items.forEach((it, i) => {
    const g = groups.get(it.parent);
    if (g) g.push(i);
    else groups.set(it.parent, [i]);
  });
  let changed = false;
  for (const idxs of groups.values()) {
    const ranks = idxs.map((i) => items[i].rank);
    const keep = keepers(ranks);
    if (keep.length === idxs.length) continue;
    changed = true;
    let start = 0;
    for (let k = 0; k <= keep.length; k++) {
      const end = k < keep.length ? keep[k] : idxs.length;
      const lo = k === 0 ? null : (ranks[keep[k - 1]] as string);
      const hi = k < keep.length ? (ranks[keep[k]] as string) : null;
      fill(lo, hi, end - start).forEach((r, n) => (items[idxs[start + n]].rank = r));
      start = end + 1;
    }
  }
  return changed;
}

/** Order siblings by rank (ties by id). Follow with `normalize`. */
export function sortSiblings(items: Item[]) {
  items.sort((a, b) => ((a.rank ?? "") < (b.rank ?? "") ? -1 : (a.rank ?? "") > (b.rank ?? "") ? 1 : a.id - b.id));
}

// ---------- pre-order (store.rs normalize) ----------

export function normalize(list: Item[]): Item[] {
  const ids = new Set(list.map((i) => i.id));
  for (const i of list) if (i.parent !== null && (i.parent === i.id || !ids.has(i.parent))) i.parent = null;
  const byParent = new Map<number | null, Item[]>();
  for (const i of list) {
    const g = byParent.get(i.parent);
    if (g) g.push(i);
    else byParent.set(i.parent, [i]);
  }
  const out: Item[] = [];
  const seen = new Set<number>();
  const emit = (parent: number | null) => {
    for (const i of byParent.get(parent) ?? []) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
      emit(i.id);
    }
  };
  emit(null);
  for (const i of list) {
    if (!seen.has(i.id)) {
      // Part of a cycle: make it top-level.
      i.parent = null;
      seen.add(i.id);
      out.push(i);
    }
  }
  return out;
}

// ---------- the outline's whole-list save (store.rs set_from_frontend) ----------

export function sameContent(a: Item, b: Item): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.kind === b.kind &&
    a.done === b.done &&
    a.parent === b.parent &&
    a.created_at === b.created_at &&
    (a.done_at ?? null) === (b.done_at ?? null) &&
    JSON.stringify(a.schedule ?? null) === JSON.stringify(b.schedule ?? null)
  );
}

/**
 * Take the outline's save without undoing what a pull changed behind it. Only
 * rows the user touched, added or removed (compared with `seen`, the list the
 * outline last loaded or sent) are taken from `incoming`.
 */
export function mergeFrontend(stored: Item[], seen: Item[], incoming: Item[]): Item[] {
  const seenById = new Map(seen.map((i) => [i.id, i]));
  const storedById = new Map(stored.map((i) => [i.id, i]));
  const incomingIds = new Set(incoming.map((i) => i.id));
  const shape = (v: Item[]) => v.map((i) => `${i.id}:${i.parent}`).join(",");
  const structureSame = shape(incoming) === shape(seen);

  const out: Item[] = [];
  for (const inc of incoming) {
    const s = seenById.get(inc.id);
    const touched = !s || !sameContent(inc, s);
    const st = storedById.get(inc.id);
    if (st) out.push(touched ? { ...inc, rank: st.rank } : { ...st });
    else if (touched) out.push({ ...inc, rank: "" });
  }
  const unseen = stored.filter((i) => !seenById.has(i.id) && !incomingIds.has(i.id)).map((i) => ({ ...i }));

  let merged: Item[];
  if (structureSame) {
    const byId = new Map(out.map((i) => [i.id, i]));
    merged = [];
    for (const st of stored) {
      const i = byId.get(st.id);
      if (i) {
        merged.push(i);
        byId.delete(st.id);
      } else if (!seenById.has(st.id)) merged.push({ ...st });
    }
    for (const inc of incoming) {
      const i = byId.get(inc.id);
      if (i) merged.push(i);
    }
  } else {
    merged = out;
    for (const u of unseen) {
      const at = merged.findIndex((i) => i.parent === u.parent && !!i.rank && i.rank > (u.rank ?? ""));
      merged.splice(at < 0 ? merged.length : at, 0, u);
    }
  }
  return normalize(merged);
}

// ---------- push / pull (sync.rs) ----------

export interface SyncState {
  /** This device as the server names it (the session). */
  device: string;
  account: string;
  since: number;
  hlc: number;
  /** Per row, the copy last agreed with the server. */
  base: Record<string, WireRow>;
  /** Local changes not yet acknowledged, stamped when first noticed. */
  pending: Record<string, WireRow>;
}

export const emptyState = (): SyncState => ({ device: "", account: "", since: 0, hlc: 0, base: {}, pending: {} });

function contentEq(a: WireRow, b: WireRow): boolean {
  return (
    a.text === b.text &&
    a.kind === b.kind &&
    a.done === b.done &&
    a.parent === b.parent &&
    a.rank === b.rank &&
    a.created_at === b.created_at &&
    (a.done_at ?? null) === (b.done_at ?? null) &&
    JSON.stringify(a.schedule ?? null) === JSON.stringify(b.schedule ?? null) &&
    (a.archived_at ?? null) === (b.archived_at ?? null)
  );
}

function toWire(it: Item, archivedAt: number | null): WireRow {
  return {
    id: String(it.id),
    text: it.text,
    kind: it.kind === "task" ? "task" : "note",
    done: !!it.done,
    parent: it.parent === null ? null : String(it.parent),
    rank: it.rank ?? "",
    created_at: it.created_at,
    done_at: it.done_at ?? null,
    schedule: it.schedule ? { start: it.schedule.start, end: it.schedule.end, all_day: !!it.schedule.all_day, event_id: it.schedule.event_id ?? null } : null,
    archived_at: archivedAt,
    updated_at: 0,
    updated_by: "",
    deleted: false,
  };
}

/** Ids this app can hold: whole numbers JavaScript represents exactly. */
function toId(s: string | null): number | null {
  if (s === null || !/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function toItem(r: WireRow): Item | null {
  const id = toId(r.id);
  if (id === null) return null;
  return {
    id,
    text: r.text,
    kind: r.kind === "task" ? "task" : "note",
    done: r.done,
    parent: toId(r.parent),
    created_at: r.created_at,
    done_at: r.done_at,
    schedule: r.schedule,
    rank: r.rank,
  };
}

export function localRows(items: Item[], archive: ArchivedItem[]): Map<string, WireRow> {
  const map = new Map<string, WireRow>();
  for (const a of archive) map.set(String(a.id), toWire(a, a.archived_at));
  for (const it of items) map.set(String(it.id), toWire(it, null));
  return map;
}

/** What a cycle would push; stamps are kept in `state.pending`. */
export function planRows(state: SyncState, local: Map<string, WireRow>, nowMs: number): { rows: WireRow[]; deletes: number } {
  const wanted = new Map<string, WireRow>();
  for (const [id, cur] of local) {
    const b = state.base[id];
    if (b && contentEq(cur, b)) continue;
    wanted.set(id, { ...cur });
  }
  for (const [id, b] of Object.entries(state.base)) {
    if (!local.has(id)) wanted.set(id, { ...b, deleted: true });
  }
  const old = state.pending;
  state.pending = {};
  for (const [id, row] of wanted) {
    const p = old[id];
    const kept = p && p.deleted === row.deleted && contentEq(p, row) ? p.updated_at : null;
    if (kept === null) state.hlc = Math.max(nowMs, state.hlc + 1);
    row.updated_at = kept ?? state.hlc;
    row.updated_by = state.device;
    delete row.seq;
    state.pending[id] = row;
  }
  const all = Object.values(state.pending);
  const rows = [...all].sort((a, b) => a.updated_at - b.updated_at).slice(0, PAGE);
  return { rows, deletes: all.filter((r) => r.deleted).length };
}

/** Fold the server's answer into the store. Returns the new lists and whether they changed. */
export function applyRows(state: SyncState, items: Item[], archive: ArchivedItem[], sent: WireRow[], rows: WireRow[]): { items: Item[]; archive: ArchivedItem[]; changed: boolean } {
  if (!rows.length) return { items, archive, changed: false };
  const sentById = new Map(sent.map((r) => [r.id, r]));
  const local = localRows(items, archive);
  const upserts = new Map<number, WireRow>();
  const removes = new Set<number>();

  for (const r of rows) {
    state.hlc = Math.max(state.hlc, r.updated_at);
    const id = r.id;
    if (r.updated_by === state.device) {
      // Something this device sent; if the row moved on since, the next plan sees it differ.
      if (state.pending[id]?.updated_at === r.updated_at) delete state.pending[id];
      if (r.deleted) delete state.base[id];
      else state.base[id] = r;
      continue;
    }
    // Another device's write stands unless this row changed here since the
    // copy we last sent or agreed on.
    const cur = local.get(id);
    const agreed = sentById.get(id) ?? state.base[id];
    let untouched: boolean;
    if (!agreed) untouched = true;
    else if (cur) untouched = !agreed.deleted && contentEq(cur, agreed);
    else untouched = agreed.deleted;
    delete state.pending[id];
    if (untouched) {
      const n = toId(id);
      if (n === null) console.warn("sync: skipping a row with an id this app can't hold");
      else if (r.deleted) {
        if (local.delete(id)) {
          removes.add(n);
          upserts.delete(n);
        }
      } else if (!cur || !contentEq(cur, r)) {
        local.set(id, r);
        removes.delete(n);
        upserts.set(n, r);
      }
    }
    if (r.deleted) delete state.base[id];
    else state.base[id] = r;
  }

  if (!upserts.size && !removes.size) return { items, archive, changed: false };
  const gone = (id: number) => removes.has(id) || upserts.has(id);
  let nextItems = items.filter((i) => !gone(i.id));
  const nextArchive = archive.filter((a) => !gone(a.id));
  for (const row of upserts.values()) {
    const item = toItem(row);
    if (!item) continue;
    if (row.archived_at !== null && row.archived_at !== undefined) nextArchive.push({ ...item, archived_at: row.archived_at });
    else nextItems.push(item);
  }
  sortSiblings(nextItems);
  nextItems = normalize(nextItems);
  return { items: nextItems, archive: nextArchive, changed: true };
}
