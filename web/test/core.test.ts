// Checks for web/src/core.ts, the TypeScript twin of the desktop's rank, merge
// and sync functions. Run with `npm run test:web` (Node, no browser).

import type { ArchivedItem, Item } from "../../src/outline.ts";
import type { WireRow } from "../../shared/protocol.ts";
import { applyRows, between, emptyState, localRows, mergeFrontend, normalize, planRows, repairRanks, validRank, type SyncState } from "../src/core.ts";

let failures = 0;
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures++;
};
const item = (id: number, text: string, parent: number | null = null, rank = ""): Item => ({ id, text, kind: "note", done: false, parent, created_at: 1, done_at: null, schedule: null, rank });
const increasing = (v: (string | undefined)[]) => v.every((r, i) => validRank(r) && (i === 0 || (v[i - 1] as string) < (r as string)));

// ---------- ranks ----------
for (const [a, b] of [[null, null], ["V", null], [null, "V"], ["V", "W"], ["V", "V1"], ["Vz", "W"], [null, "1"], [null, "01"], ["zzzzzz", null], ["zzzzzzz", null]] as [string | null, string | null][]) {
  const m = between(a, b);
  ok(validRank(m) && (a === null || a < m) && (b === null || m < b), `between(${a}, ${b}) = ${m}`);
}
{
  let a = between(null, null);
  const b = between(a, null);
  let good = true;
  for (let i = 0; i < 200; i++) {
    const m = between(a, b);
    good &&= a < m && m < b && validRank(m);
    a = m;
  }
  ok(good, "200 inserts at one spot stay ordered");
  let last = between(null, null);
  for (let i = 0; i < 5000; i++) last = between(last, null);
  ok(last.length <= 6, "5000 appends do not grow the rank");
  // The same starting rank and step as the desktop (rank.rs), so mixed devices interleave sanely.
  ok(between(null, null) === "V" && between("V", null) === "V01", "first ranks match the desktop's");
}
{
  const items = Array.from({ length: 6 }, (_, i) => item(i + 1, "x"));
  repairRanks(items);
  const orig = items.map((i) => i.rank);
  ok(increasing(orig), "a fresh list gets increasing ranks");
  ok(!repairRanks(items), "and repairing again changes nothing");
  items.unshift(items.pop()!);
  items.splice(3, 0, item(99, "new"));
  repairRanks(items);
  ok(increasing(items.map((i) => i.rank)), "after a move and an insert the ranks follow the order");
  ok(JSON.stringify(items.filter((i) => i.id <= 5).map((i) => i.rank)) === JSON.stringify(orig.slice(0, 5)), "rows that stayed keep their ranks");
  const junk = [item(1, "", null, "V"), item(2, "", null, "V"), item(3, "", null, "not a rank!"), item(4, "", null, "V0"), item(5, "", null, "W")];
  repairRanks(junk);
  ok(increasing(junk.map((i) => i.rank)), "duplicates and garbage are repaired");
}

// ---------- normalize ----------
{
  const out = normalize([item(3, "", 1), item(1, ""), item(2, "", 1), item(7, "", 9), item(5, "", 6), item(6, "", 5)]);
  ok(JSON.stringify(out.map((i) => [i.id, i.parent])) === JSON.stringify([[1, null], [3, 1], [2, 1], [7, null], [5, null], [6, null]]), "normalize puts rows in pre-order and breaks cycles");
}

// ---------- the outline's whole-list save ----------
{
  let stored = [item(1, "one"), item(2, "two"), item(3, "three")];
  repairRanks(stored);
  const loaded = stored.map((i) => ({ ...i }));
  // Behind the outline's back: 2 edited, 3 removed, 4 added.
  stored = [stored[0], { ...stored[1], text: "two, edited elsewhere" }, item(4, "four", null, between(stored[2].rank!, null))];
  const sent = loaded.map((i) => ({ ...i }));
  sent[0].text = "one, edited here";
  const merged = mergeFrontend(stored, loaded, sent);
  ok(JSON.stringify(merged.map((i) => [i.id, i.text])) === JSON.stringify([[1, "one, edited here"], [2, "two, edited elsewhere"], [4, "four"]]), "a stale save keeps the remote edit, removal and addition");
  const moved = mergeFrontend(loaded, loaded, [loaded[2], loaded[0], item(9, "child", 1)]);
  ok(JSON.stringify(moved.map((i) => [i.id, i.parent])) === JSON.stringify([[3, null], [1, null], [9, 1]]), "the outline can still delete, move and add");
}

// ---------- sync ----------
class Server {
  rows = new Map<string, WireRow>();
  seq = 0;
  sync(since: number, sent: WireRow[]): { seq: number; rows: WireRow[] } {
    const refused: WireRow[] = [];
    for (const r of sent) {
      const cur = this.rows.get(r.id);
      if (cur && !(r.updated_at > cur.updated_at || (r.updated_at === cur.updated_at && r.updated_by > cur.updated_by))) {
        if ((cur.seq ?? 0) <= since) refused.push(cur);
        continue;
      }
      this.rows.set(r.id, { ...r, seq: ++this.seq });
    }
    const out = [...this.rows.values()].filter((r) => (r.seq ?? 0) > since).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { seq: this.seq, rows: [...out, ...refused].map((r) => ({ ...r })) };
  }
}

class Device {
  state: SyncState;
  items: Item[] = [];
  archive: ArchivedItem[] = [];
  clock: number;
  constructor(name: string, clock: number) {
    this.state = { ...emptyState(), device: name };
    this.clock = clock;
  }
  saved() {
    this.items = normalize(this.items);
    repairRanks(this.items);
  }
  add(id: number, text: string, parent: number | null = null) {
    this.items.push(item(id, text, parent));
    this.saved();
  }
  edit(id: number, text: string) {
    this.items.find((i) => i.id === id)!.text = text;
  }
  sync(server: Server): boolean {
    this.clock += 1000;
    let changed = false;
    const take = (sent: WireRow[], r: { seq: number; rows: WireRow[] }) => {
      const a = applyRows(this.state, this.items, this.archive, sent, r.rows);
      if (a.changed) {
        this.items = a.items;
        this.archive = a.archive;
        changed = true;
      }
      this.state.since = r.seq;
    };
    if (this.state.since === 0 && !Object.keys(this.state.base).length) take([], server.sync(0, []));
    const { rows } = planRows(this.state, localRows(this.items, this.archive), this.clock);
    take(rows, server.sync(this.state.since, rows));
    if (changed) this.saved();
    return changed;
  }
  view() {
    return JSON.stringify(this.items.map((i) => [i.id, i.text, i.parent]));
  }
}

{
  const server = new Server();
  const a = new Device("a", 1_000_000);
  const b = new Device("b", 1_000_500);
  a.add(1, "one");
  a.add(2, "two");
  a.add(3, "child of one", 1);
  ok(!a.sync(server), "a first push changes nothing locally");
  ok(b.sync(server) && a.view() === b.view(), "a fresh device pulls everything, nested and ordered");
  a.edit(1, "one, by a");
  b.edit(2, "two, by b");
  a.sync(server);
  b.sync(server);
  a.sync(server);
  ok(a.view() === b.view() && a.view().includes("one, by a") && a.view().includes("two, by b"), "edits to different rows merge");
  const before = server.seq;
  a.sync(server);
  b.sync(server);
  ok(server.seq === before && !Object.keys(a.state.pending).length, "idle cycles write nothing");

  a.edit(1, "a's version");
  b.clock += 60_000;
  b.edit(1, "b's later version");
  b.sync(server);
  a.sync(server);
  b.sync(server);
  ok(a.view() === b.view() && a.view().includes("b's later version"), "the later edit of one row wins on both sides");

  // Delete, archive, move.
  a.items = a.items.filter((i) => i.id !== 3);
  const two = a.items.find((i) => i.id === 2)!;
  a.items = a.items.filter((i) => i.id !== 2);
  a.archive.push({ ...two, archived_at: 99 });
  a.add(4, "four");
  a.add(5, "five");
  a.sync(server);
  b.sync(server);
  ok(a.view() === b.view() && b.archive.length === 1 && b.archive[0].archived_at === 99, "deletes and archiving travel");
  b.items.unshift(b.items.pop()!);
  b.saved();
  b.sync(server);
  a.sync(server);
  ok(a.view() === b.view() && a.items[0].id === 5, "a reorder alone travels");

  // An edit made while a request is in flight is kept and sent next.
  b.edit(1, "from b");
  b.sync(server);
  const { rows: sent } = planRows(a.state, localRows(a.items, a.archive), a.clock + 5000);
  const resp = server.sync(a.state.since, sent);
  a.edit(1, "typed on a meanwhile");
  const applied = applyRows(a.state, a.items, a.archive, sent, resp.rows);
  a.state.since = resp.seq;
  ok(!applied.changed && a.view().includes("typed on a meanwhile"), "a row being typed in is left alone by a pull");
  a.clock += 10_000;
  a.sync(server);
  b.sync(server);
  ok(b.view().includes("typed on a meanwhile"), "and that edit reaches the other device");
}
{
  const state: SyncState = { ...emptyState(), device: "a" };
  const local = localRows([item(1, "x", null, "V")], []);
  const first = planRows(state, local, 1000).rows[0].updated_at;
  ok(planRows(state, local, 9_000_000).rows[0].updated_at === first, "an offline edit keeps the time it was made");
  const many = Array.from({ length: 40 }, (_, i) => item(i + 1, "row"));
  repairRanks(many);
  const s2: SyncState = { ...emptyState(), device: "a" };
  for (const [id, r] of localRows(many, [])) s2.base[id] = r;
  ok(planRows(s2, localRows([], []), 1).deletes === 40, "a wiped store shows up as a mass deletion before anything is sent");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
