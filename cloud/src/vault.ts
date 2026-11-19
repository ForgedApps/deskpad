// The Markdown vault: a tenant's notes written out as plain files, for people
// (Obsidian and Logseq open the folder as it is) and for an AI to read as
// context. It is a generated, one-way copy; the rows stay the truth.
//
//   outline.md            the outline as it stands now
//   daily/YYYY-MM-DD.md   that day's calendar events, the rows written that
//                         day (archived ones too) and the tasks finished on it
//   topics/<name>.md      every row that mentions [[name]]
//   tags/<tag>.md         every row tagged #tag
//   index.md              where everything is
//
// `buildVault` is pure: rows and days in, files out. Keep it that way so it can
// be tested without a Worker.

import type { WireDay, WireRow } from "../../shared/protocol";

export interface VaultOptions {
  /** IANA zone that decides which day a row belongs to. */
  tz: string;
  /** The Worker's origin, for links to pasted images. */
  origin: string;
}

interface Event {
  title?: string;
  start?: number;
  end?: number;
  all_day?: boolean;
  location?: string | null;
  url?: string | null;
}

const LINK_RE = /\[\[([^\[\]|\n]{1,80})\]\]/g;
const TAG_RE = /(?:^|[\s(])#([A-Za-z][\w-]{0,49})(?![\w-])/g;
const CODE_RE = /`[^`\n]+`/g;

/** A name that is safe as a file name on every system, and stable. */
export function fileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
}

function clock(tz: string) {
  let zone = tz;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const titleFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return {
    day: (unix: number) => dayFmt.format(new Date(unix * 1000)),
    time: (unix: number) => timeFmt.format(new Date(unix * 1000)),
    title: (day: string) => titleFmt.format(new Date(`${day}T12:00:00Z`)),
  };
}

export function buildVault(allRows: WireRow[], days: WireDay[], opts: VaultOptions): Map<string, string> {
  const at = clock(opts.tz);
  const rows = allRows.filter((r) => !r.deleted);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string | null, WireRow[]>();
  for (const r of rows) {
    // A row whose parent is gone, or archived away from it, stands on its own.
    const p = r.parent !== null && byId.has(r.parent) ? r.parent : null;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(r);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.created_at - b.created_at));

  const line = (r: WireRow): string => {
    let text = r.text.replace(/\s*\n\s*/g, " ").trim();
    text = text.replace(/\]\(img:([\w.-]+)\)/g, `](${opts.origin}/api/v1/images/$1)`);
    const box = r.kind === "task" ? (r.done ? "[x] " : "[ ] ") : "";
    let when = "";
    if (r.schedule) when = r.schedule.all_day ? ` (scheduled ${at.day(r.schedule.start)})` : ` (scheduled ${at.day(r.schedule.start)} ${at.time(r.schedule.start)})`;
    return `${box}${text || "(empty)"}${when}`;
  };

  /** A row and what is under it as nested bullets; `keep` limits which rows are drawn. */
  const tree = (r: WireRow, depth: number, keep: (r: WireRow) => boolean, out: string[]) => {
    out.push(`${"  ".repeat(depth)}- ${line(r)}`);
    for (const c of kids.get(r.id) ?? []) if (keep(c)) tree(c, depth + 1, keep, out);
  };

  const files = new Map<string, string>();

  // ----- outline.md -----
  const live = (r: WireRow) => r.archived_at === null;
  const outline: string[] = [];
  const liveRoot = (r: WireRow) => live(r) && (r.parent === null || !byId.has(r.parent) || !live(byId.get(r.parent)!));
  const byRank = (a: WireRow, b: WireRow) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.created_at - b.created_at);
  for (const r of rows.filter(liveRoot).sort(byRank)) tree(r, 0, live, outline);
  files.set("outline.md", `# Outline\n\nThe notes and tasks in the sidebar right now.\n\n${outline.join("\n") || "_Nothing here._"}\n`);

  // ----- daily/ -----
  const dayOf = new Map(rows.map((r) => [r.id, at.day(r.created_at)]));
  const written = new Map<string, WireRow[]>();
  const finished = new Map<string, WireRow[]>();
  for (const r of rows) {
    const d = dayOf.get(r.id)!;
    (written.get(d) ?? written.set(d, []).get(d)!).push(r);
    if (r.kind === "task" && r.done && r.done_at) {
      const f = at.day(r.done_at);
      if (f !== d) (finished.get(f) ?? finished.set(f, []).get(f)!).push(r);
    }
  }
  const events = new Map(days.map((d) => [d.day, d.events as Event[]]));
  const allDays = [...new Set([...written.keys(), ...finished.keys(), ...events.keys()])].sort();

  for (const day of allDays) {
    const out: string[] = [`# ${at.title(day)}`, ""];
    const evs = (events.get(day) ?? []).filter((e) => e && typeof e.title === "string");
    if (evs.length) {
      out.push("## Events", "");
      for (const e of evs.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
        const when = e.all_day || !e.start ? "All day" : `${at.time(e.start)}${e.end ? `–${at.time(e.end)}` : ""}`;
        const where = e.location && !/^https?:/i.test(e.location) ? ` (${e.location})` : "";
        out.push(`- ${when} ${e.title}${where}`);
      }
      out.push("");
    }
    const mine = written.get(day) ?? [];
    if (mine.length) {
      out.push("## Notes", "");
      const sameDay = (r: WireRow) => dayOf.get(r.id) === day;
      for (const r of mine) {
        const parent = r.parent !== null ? byId.get(r.parent) : undefined;
        if (parent && sameDay(parent)) continue; // drawn under its parent
        const before = out.length;
        tree(r, 0, sameDay, out);
        // Written under an older row: say which, so the line makes sense alone.
        if (parent) out[before] += ` _(under: ${plain(parent.text).slice(0, 60)})_`;
      }
      out.push("");
    }
    const done = finished.get(day) ?? [];
    if (done.length) {
      out.push("## Completed", "");
      for (const r of done) out.push(`- ${line(r)} _(from [[${dayOf.get(r.id)}]])_`);
      out.push("");
    }
    files.set(`daily/${day}.md`, out.join("\n"));
  }

  // ----- topics/ and tags/ -----
  const topics = new Map<string, { name: string; rows: WireRow[] }>();
  const tags = new Map<string, { name: string; rows: WireRow[] }>();
  const note = (into: typeof topics, name: string, r: WireRow) => {
    const key = name.toLowerCase();
    const hit = into.get(key) ?? into.set(key, { name, rows: [] }).get(key)!;
    if (!hit.rows.includes(r)) hit.rows.push(r);
  };
  for (const r of rows) {
    const text = r.text.replace(CODE_RE, "");
    for (const m of text.matchAll(LINK_RE)) note(topics, fileName(m[1]), r);
    for (const m of text.replace(LINK_RE, "").matchAll(TAG_RE)) note(tags, m[1], r);
  }
  const mentions = (dir: string, title: string, found: typeof topics) => {
    for (const { name, rows: hits } of found.values()) {
      const out = [`# ${title}${name}`, "", `${hits.length} ${hits.length === 1 ? "mention" : "mentions"}.`, ""];
      for (const r of hits.sort((a, b) => b.created_at - a.created_at)) out.push(`- ${line(r)} _([[${dayOf.get(r.id)}]])_`);
      files.set(`${dir}/${name}.md`, out.join("\n") + "\n");
    }
  };
  mentions("topics", "", topics);
  mentions("tags", "#", tags);

  // ----- index.md -----
  const index = ["# Deskpad notes", "", "A generated copy of the notes in Deskpad. Edits made here are not read back.", "", "- [[outline]]: what is in the sidebar now", ""];
  const list = (title: string, dir: string, found: typeof topics, mark: string) => {
    if (!found.size) return;
    index.push(`## ${title}`, "");
    for (const t of [...found.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name))) {
      index.push(`- [${mark}${t.name}](${dir}/${encodeURI(t.name)}.md) (${t.rows.length})`);
    }
    index.push("");
  };
  list("Topics", "topics", topics, "");
  list("Tags", "tags", tags, "#");
  if (allDays.length) {
    index.push("## Days", "");
    for (const day of [...allDays].reverse()) index.push(`- [[${day}]]`);
    index.push("");
  }
  files.set("index.md", index.join("\n"));
  return files;
}

/** Row text without Markdown markers, for a short mention of it. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]\n]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ----- zip -----

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of text files, stored without compression (they are small). */
export function zip(files: { path: string; body: Uint8Array }[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.body.length, true);
    local.setUint32(22, f.body.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.body.length, true);
    cd.setUint32(24, f.body.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
