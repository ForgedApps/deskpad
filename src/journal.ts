// The Journal window: every day as a record. The sidebar's outline is the
// workspace; here each day shows the calendar events of that day (live from
// Google, falling back to what the sidebar recorded), the rows written that
// day (live and archived alike), tasks completed that day and tasks scheduled
// for it. Rows are read-only here; archived ones can be restored or deleted
// and live ones can be shown in the sidebar.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initImages } from "./images";
import type { ArchivedItem, Item } from "./outline";
import { addDays, dayKey, escapeHtml, fmtDayTitle, fmtTime, keyToDate, relativeDayName, renderInline, stripInline, todayKey } from "./text";
import { fmtSchedule } from "./schedule";

interface Meeting {
  id: string;
  title: string;
  start: number;
  end: number;
  all_day: boolean;
  location: string | null;
  url: string | null;
}

interface JournalData {
  items: Item[];
  archive: ArchivedItem[];
  day_events: Record<string, Meeting[]>;
}

interface MeetingsResult {
  source: "google" | "none";
  meetings: Meeting[];
}

/** A row from either list, tagged with where it lives. */
interface JRow {
  item: Item;
  archived: boolean;
  archived_at: number | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const CHECK = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>`;

let data: JournalData = { items: [], archive: [], day_events: {} };
let rows: JRow[] = [];
let day = todayKey();
let query = "";
/** Live calendar fetches by day; `live: false` marks the recorded fallback. */
const eventsCache = new Map<string, { meetings: Meeting[]; live: boolean; note: string }>();
let loadSeq = 0;

// ---------- data ----------

async function loadData() {
  try {
    data = await invoke<JournalData>("list_journal");
  } catch (err) {
    console.error("list_journal failed", err);
    $("#j-main").innerHTML = `<div class="error">Couldn't load the journal: ${escapeHtml(String(err))}</div>`;
    return;
  }
  rows = [
    ...data.items.map((item) => ({ item, archived: false, archived_at: null })),
    ...data.archive.map((a) => {
      const { archived_at, ...item } = a;
      return { item: item as Item, archived: true, archived_at };
    }),
  ];
  render();
}

const byId = (id: number) => rows.find((r) => r.item.id === id);

/** Days that have anything, newest first, with what they have. */
function activeDays(): Map<string, { notes: number; done: number; sched: number; events: number }> {
  const days = new Map<string, { notes: number; done: number; sched: number; events: number }>();
  const bump = (key: string, field: "notes" | "done" | "sched" | "events") => {
    const d = days.get(key) ?? { notes: 0, done: 0, sched: 0, events: 0 };
    d[field]++;
    days.set(key, d);
  };
  for (const r of rows) {
    bump(dayKey(r.item.created_at), "notes");
    if (r.item.done && r.item.done_at) bump(dayKey(r.item.done_at), "done");
    if (r.item.schedule) bump(dayKey(r.item.schedule.start), "sched");
  }
  for (const [key, evs] of Object.entries(data.day_events)) if (evs.length) bump(key, "events");
  const today = todayKey();
  if (!days.has(today)) days.set(today, { notes: 0, done: 0, sched: 0, events: 0 });
  return new Map([...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)));
}

// ---------- rendering ----------

function render() {
  renderHeader();
  renderTimeline();
  if (query.trim()) renderSearch();
  else void renderDay();
}

function renderHeader() {
  const rel = relativeDayName(day);
  $("#j-title").innerHTML = `${escapeHtml(fmtDayTitle(day))}${rel ? ` <span class="tag">${rel}</span>` : ""}`;
  $<HTMLInputElement>("#j-date").value = day;
  $<HTMLButtonElement>("#j-today").hidden = day === todayKey();
  document.title = `Deskpad Journal · ${fmtDayTitle(day)}`;
}

function renderTimeline() {
  const el = $("#j-timeline");
  const frag = document.createDocumentFragment();
  let month = "";
  for (const [key, c] of activeDays()) {
    const d = keyToDate(key);
    const m = d.toLocaleDateString([], { month: "long", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
    if (m !== month) {
      month = m;
      const h = document.createElement("div");
      h.className = "j-month";
      h.textContent = m;
      frag.appendChild(h);
    }
    const row = document.createElement("button");
    row.className = `j-dayrow${key === day ? " selected" : ""}${key === todayKey() ? " today" : ""}`;
    row.dataset.day = key;
    const rel = relativeDayName(key);
    row.innerHTML = `<span class="wd">${d.toLocaleDateString([], { weekday: "short" })}</span><span class="dn">${d.getDate()}</span>${rel ? `<span class="rel">${rel}</span>` : ""}<span class="dots"></span>`;
    const dots = row.querySelector(".dots")!;
    const dot = (cls: string, n: number, label: string) => {
      if (!n) return;
      const s = document.createElement("span");
      s.className = `dot ${cls}`;
      s.title = `${n} ${label}`;
      dots.appendChild(s);
    };
    dot("ev", c.events, "events");
    dot("note", c.notes, "notes");
    dot("done", c.done, "completed");
    dot("sched", c.sched, "scheduled");
    row.addEventListener("click", () => selectDay(key));
    frag.appendChild(row);
  }
  el.replaceChildren(frag);
  el.querySelector<HTMLElement>(".j-dayrow.selected")?.scrollIntoView({ block: "nearest" });
}

function section(title: string, note?: string): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = document.createElement("section");
  wrap.className = "j-section";
  const h = document.createElement("h3");
  h.textContent = title;
  if (note) {
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = note;
    h.appendChild(n);
  }
  const body = document.createElement("div");
  body.className = "list";
  wrap.append(h, body);
  return { wrap, body };
}

function emptyLine(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "empty";
  e.textContent = text;
  return e;
}

async function renderDay() {
  const seq = ++loadSeq;
  const main = $("#j-main");
  const frag = document.createDocumentFragment();

  // ---- events (live, else recorded)
  const ev = section("Calendar");
  ev.body.appendChild(emptyLine("Loading…"));
  frag.appendChild(ev.wrap);

  // ---- rows written that day, nested when parent and child share the day
  const written = rows.filter((r) => dayKey(r.item.created_at) === day).sort((a, b) => a.item.created_at - b.item.created_at);
  const writtenIds = new Set(written.map((r) => r.item.id));
  const notes = section("Written", written.length ? `${written.length}` : undefined);
  if (!written.length) notes.body.appendChild(emptyLine(day === todayKey() ? "Nothing written yet today." : "Nothing written this day."));
  const renderTree = (r: JRow, depth: number) => {
    notes.body.appendChild(renderRow(r, depth ? { depth } : { context: true }));
    for (const c of written.filter((c) => c.item.parent === r.item.id)) renderTree(c, depth + 1);
  };
  for (const r of written) {
    if (r.item.parent !== null && writtenIds.has(r.item.parent)) continue; // rendered under its parent
    renderTree(r, 0);
  }
  frag.appendChild(notes.wrap);

  // ---- completed that day (written another day)
  const done = rows
    .filter((r) => r.item.done && r.item.done_at && dayKey(r.item.done_at) === day && !writtenIds.has(r.item.id))
    .sort((a, b) => (a.item.done_at ?? 0) - (b.item.done_at ?? 0));
  if (done.length) {
    const s = section("Completed", `${done.length}`);
    for (const r of done) s.body.appendChild(renderRow(r, { context: true, when: r.item.done_at! }));
    frag.appendChild(s.wrap);
  }

  // ---- scheduled for that day (written another day)
  const sched = rows
    .filter((r) => r.item.schedule && dayKey(r.item.schedule.start) === day && !writtenIds.has(r.item.id))
    .sort((a, b) => a.item.schedule!.start - b.item.schedule!.start);
  if (sched.length) {
    const s = section("Scheduled", `${sched.length}`);
    for (const r of sched) s.body.appendChild(renderRow(r, { context: true, when: r.item.schedule!.start }));
    frag.appendChild(s.wrap);
  }

  main.replaceChildren(frag);
  wireLinks(main);

  const events = await loadEvents(day);
  if (seq !== loadSeq) return;
  ev.body.replaceChildren();
  if (events.note) {
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = events.note;
    ev.wrap.querySelector("h3")!.appendChild(n);
  }
  if (!events.meetings.length) ev.body.appendChild(emptyLine(events.live || events.note ? "No events." : "No events recorded."));
  for (const m of events.meetings) ev.body.appendChild(renderMeeting(m));
  wireLinks(ev.body);
}

/** Live from Google when possible; otherwise what the sidebar recorded. */
async function loadEvents(key: string): Promise<{ meetings: Meeting[]; live: boolean; note: string }> {
  const cached = eventsCache.get(key);
  if (cached?.live) return cached;
  const recorded = data.day_events[key] ?? [];
  let result: { meetings: Meeting[]; live: boolean; note: string };
  try {
    const from = Math.floor(keyToDate(key).getTime() / 1000);
    const to = Math.floor(keyToDate(addDays(key, 1)).getTime() / 1000);
    const r = await invoke<MeetingsResult>("get_meetings", { from, to });
    if (r.source === "none") {
      result = { meetings: recorded, live: false, note: recorded.length ? "as recorded · Google not connected" : "Google not connected" };
    } else {
      result = { meetings: r.meetings, live: true, note: "" };
    }
  } catch (err) {
    console.error("get_meetings failed", err);
    result = { meetings: recorded, live: false, note: recorded.length ? "as recorded · calendar unavailable" : "calendar unavailable" };
  }
  eventsCache.set(key, result);
  return result;
}

function renderMeeting(m: Meeting): HTMLElement {
  const card = document.createElement("div");
  card.className = "meeting";
  const when = m.all_day ? "all day" : fmtTime(m.start);
  const range = m.all_day ? "All day" : `${fmtTime(m.start)} – ${fmtTime(m.end)}`;
  card.title = `${range}${m.location && !m.location.startsWith("http") ? `\n${m.location}` : ""}`;
  card.innerHTML = `
    <span class="m-when">${escapeHtml(when)}</span>
    <span class="m-title"></span>
    <span class="m-rel">${m.all_day ? "" : escapeHtml(fmtTime(m.end))}</span>
    ${m.url ? `<a class="m-join" href="${escapeHtml(m.url)}" data-ext title="Open"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M21 3l-9 9M10 5H5v14h14v-5" /></svg></a>` : ""}
  `;
  card.querySelector(".m-title")!.textContent = m.title;
  return card;
}

function renderRow(r: JRow, opts: { context?: boolean; depth?: number; when?: number }): HTMLElement {
  const it = r.item;
  const row = document.createElement("div");
  row.className = `row ${it.kind}${it.done ? " done" : ""}${r.archived ? " arch" : ""}${opts.depth ? " child" : ""}`;
  row.dataset.id = String(it.id);
  if (opts.depth) row.style.setProperty("--depth", String(opts.depth));

  const mark = document.createElement("span");
  mark.className = "mark";
  if (it.kind === "task") mark.innerHTML = CHECK;

  const body = document.createElement("div");
  body.className = "body";
  const txt = document.createElement("div");
  txt.className = "txt";
  if (it.text) txt.innerHTML = renderInline(it.text);
  else {
    txt.textContent = "(empty)";
    txt.classList.add("faint");
  }
  body.appendChild(txt);

  const meta: string[] = [];
  const t = opts.when ?? it.created_at;
  meta.push(fmtTime(t));
  if (opts.when) meta.push(`written ${fmtDayShort(it.created_at)}`);
  if (opts.context && it.parent !== null) {
    const p = byId(it.parent);
    if (p) {
      const t = stripInline(p.item.text);
      meta.push(`in “${t.slice(0, 40)}${t.length > 40 ? "…" : ""}”`);
    }
  }
  if (it.schedule && opts.when !== it.schedule.start) meta.push(`on calendar ${fmtSchedule(it.schedule.start, it.schedule.all_day)}`);
  if (r.archived && r.archived_at) meta.push(`archived ${fmtDayShort(r.archived_at)}`);
  else if (it.done && it.done_at && !opts.when) meta.push(`done ${fmtDayShort(it.done_at)}`);
  const m = document.createElement("div");
  m.className = "meta";
  m.textContent = meta.join(" · ");
  body.appendChild(m);

  row.append(mark, body);

  if (r.archived) {
    row.appendChild(miniButton("Restore to notes", `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 3v6h6" /></svg>`, async () => {
      const group = [it.id, ...rows.filter((c) => c.archived && c.item.parent === it.id).map((c) => c.item.id)];
      await invoke("restore_items", { ids: group }).catch((err) => console.error("restore failed", err));
      await loadData();
    }));
    const del = miniButton("Delete permanently", `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>`, async () => {
      const group = [it.id, ...rows.filter((c) => c.archived && c.item.parent === it.id).map((c) => c.item.id)];
      if (!confirm(group.length > 1 ? `Delete this row and ${group.length - 1} nested permanently?` : "Delete this row permanently?")) return;
      await invoke("delete_archived", { ids: group }).catch((err) => console.error("delete failed", err));
      await loadData();
    });
    del.classList.add("danger");
    row.appendChild(del);
  } else {
    row.appendChild(miniButton("Show in sidebar", `<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z" /><path d="M15 5v14" /></svg>`, () => {
      invoke("show_item", { id: it.id }).catch((err) => console.error("show_item failed", err));
    }));
  }
  return row;
}

function fmtDayShort(unix: number): string {
  const key = dayKey(unix);
  const rel = relativeDayName(key);
  if (rel) return rel.toLowerCase();
  const d = keyToDate(key);
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

function miniButton(title: string, svg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "mini";
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function wireLinks(root: HTMLElement) {
  root.querySelectorAll<HTMLAnchorElement>("a[data-ext]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(a.href).catch((err) => console.error("openUrl failed", err));
    }),
  );
}

// ---------- search ----------

function renderSearch() {
  const main = $("#j-main");
  const q = query.trim().toLowerCase();
  const hits = rows.filter((r) => r.item.text.toLowerCase().includes(q)).sort((a, b) => b.item.created_at - a.item.created_at);
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "j-searchhead";
  head.textContent = hits.length ? `${hits.length} ${hits.length === 1 ? "match" : "matches"} for “${query.trim()}”` : `No notes match “${query.trim()}”.`;
  frag.appendChild(head);
  let current = "";
  let body: HTMLElement | null = null;
  for (const r of hits) {
    const key = dayKey(r.item.created_at);
    if (key !== current) {
      current = key;
      const s = section("");
      const h = s.wrap.querySelector("h3")!;
      const btn = document.createElement("button");
      btn.className = "link";
      const rel = relativeDayName(key);
      btn.textContent = `${fmtDayTitle(key)}${rel ? ` · ${rel}` : ""}`;
      btn.addEventListener("click", () => {
        query = "";
        $<HTMLInputElement>("#j-search").value = "";
        selectDay(key);
      });
      h.appendChild(btn);
      body = s.body;
      frag.appendChild(s.wrap);
    }
    body!.appendChild(renderRow(r, { context: true }));
  }
  main.replaceChildren(frag);
  wireLinks(main);
}

// ---------- navigation ----------

function selectDay(key: string) {
  day = key;
  render();
}

function wire() {
  $("#j-prev").addEventListener("click", () => selectDay(addDays(day, -1)));
  $("#j-next").addEventListener("click", () => selectDay(addDays(day, 1)));
  $("#j-today").addEventListener("click", () => selectDay(todayKey()));
  $<HTMLInputElement>("#j-date").addEventListener("change", (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) selectDay(v);
  });
  const search = $<HTMLInputElement>("#j-search");
  let t: number | undefined;
  search.addEventListener("input", () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      query = search.value;
      render();
    }, 120);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      query = "";
      render();
      search.blur();
    }
  });
  document.addEventListener("keydown", (e) => {
    const inField = (e.target as HTMLElement).matches("input, textarea, [contenteditable]");
    if (inField) return;
    if (e.key === "ArrowLeft") selectDay(addDays(day, -1));
    else if (e.key === "ArrowRight") selectDay(addDays(day, 1));
    else if (e.key === "t" || e.key === "T") selectDay(todayKey());
    else if (e.key === "/" ) {
      e.preventDefault();
      search.focus();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  wire();
  await initImages();
  await loadData();
  listen("items-changed", () => loadData()).catch((err) => console.error("listen failed", err));
  listen("calendar-changed", () => {
    eventsCache.clear();
    render();
  }).catch((err) => console.error("listen failed", err));
  listen<string>("day-events-changed", async (e) => {
    // The sidebar recorded a day; refresh our copy and redraw if we were
    // showing the recorded fallback for it.
    try {
      data = await invoke<JournalData>("list_journal");
    } catch {
      return;
    }
    if (e.payload === day && !eventsCache.get(day)?.live) {
      eventsCache.delete(day);
      render();
    } else renderTimeline();
  }).catch((err) => console.error("listen failed", err));
  listen("journal-shown", () => {
    eventsCache.clear();
    loadData();
  }).catch((err) => console.error("listen failed", err));
});

// Relay errors to the dev terminal like the other windows.
const origError = console.error;
console.error = (...args: unknown[]) => {
  origError(...args);
  invoke("log_js", { msg: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" ") }).catch(() => {});
};
window.addEventListener("error", (e) => invoke("log_js", { msg: `error: ${e.message} @${e.filename}:${e.lineno}` }).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => invoke("log_js", { msg: `unhandled: ${String(e.reason)}` }).catch(() => {}));
