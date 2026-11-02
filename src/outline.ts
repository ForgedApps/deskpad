// Workflowy-style outline: every row is a note by default, becomes a task via
// a marker (`- `, `[]`, `/task`) or Ctrl+Enter, and can nest one level under
// the item above it with Tab. The frontend owns ordering; after every change
// the whole list is sent to the backend with `set_items`.
//
// A row whose text names a date or time ("meet tom next friday at 10am") is
// scheduled when it is committed (Enter or leaving the row): the phrase is
// removed, the row becomes a task, and the backend puts it on the Google
// calendar. The badge after the text shows when; its ✕ takes it off again.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fmtSchedule, fmtScheduleLong, parseMarker, parseSchedule, type Parsed } from "./schedule";

export { parseMarker };

export interface Schedule {
  start: number;
  end: number;
  all_day: boolean;
  /** Google event id; null when the event could not be created. */
  event_id: string | null;
}

export interface Item {
  id: number;
  text: string;
  kind: "note" | "task";
  done: boolean;
  parent: number | null;
  created_at: number;
  schedule: Schedule | null;
}

export interface ArchivedItem extends Item {
  archived_at: number;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let items: Item[] = [];
/** Set once the backend list has been read. Until then nothing is ever saved,
 *  so a transient startup failure can never overwrite the stored notes. */
let loaded = false;
let saveTimer: number | undefined;
let dirty = false;
let pendingFocus: { id: number | "new"; caret: number | "end" } | null = null;

// ---------- model helpers ----------

const idx = (id: number) => items.findIndex((i) => i.id === id);
const byId = (id: number) => items.find((i) => i.id === id);
const childrenOf = (id: number) => items.filter((c) => c.parent === id);

// ---------- collapse state ----------
// Which parents are folded is a view preference, not data: it lives in
// localStorage so it survives restarts without touching tasks.json.

const COLLAPSED_KEY = "deskpad.collapsed";
const collapsed = new Set<number>(loadCollapsed());

function loadCollapsed(): number[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* view preference only */
  }
}

export function toggleCollapsed(id: number, force?: boolean) {
  const next = force ?? !collapsed.has(id);
  if (next) collapsed.add(id);
  else collapsed.delete(id);
  saveCollapsed();
  render();
}

/** Rows currently shown, i.e. everything except children of folded parents. */
function visibleItems(): Item[] {
  return items.filter((i) => i.parent === null || !collapsed.has(i.parent));
}

const CHEVRON = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>`;

/** Disclosure toggle shown in the gutter of a row that has children. */
function renderToggle(isCollapsed: boolean, count: number, onToggle: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "fold";
  btn.tabIndex = -1;
  btn.title = isCollapsed ? `Expand ${count} nested` : "Collapse";
  btn.innerHTML = CHEVRON;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
  return btn;
}

function renderCount(count: number): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "count";
  badge.textContent = String(count);
  badge.title = `${count} nested`;
  return badge;
}

/** Index of the last row in `parentId`'s block (the parent itself if childless). */
function blockEnd(parentId: number): number {
  let end = idx(parentId);
  for (let i = end + 1; i < items.length && items[i].parent === parentId; i++) end = i;
  return end;
}

function newItem(text: string, parent: number | null, kind: "note" | "task" = "note"): Item {
  return { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), text, kind, done: false, parent, created_at: Math.floor(Date.now() / 1000), schedule: null };
}

const CHECK = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>`;

function remove(id: number) {
  // Promote children so nothing is orphaned.
  for (const i of items) if (i.parent === id) i.parent = null;
  items = items.filter((i) => i.id !== id);
}

// ---------- persistence ----------

function scheduleSave() {
  dirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 250);
}

async function flushSave() {
  window.clearTimeout(saveTimer);
  if (!dirty || !loaded) return;
  dirty = false;
  try {
    await invoke("set_items", { items });
  } catch (err) {
    console.error("set_items failed", err);
    dirty = true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Move rows (and their children) to the archive; the backend owns the move. */
async function archive(ids: number[]) {
  if (!ids.length) return;
  await flushSave();
  try {
    await invoke("archive_items", { ids });
  } catch (err) {
    console.error("archive_items failed", err);
  }
  await loadItems();
}

export async function loadItems() {
  let fetched: Item[] | null = null;
  for (let attempt = 0; attempt < 5 && fetched === null; attempt++) {
    try {
      fetched = await invoke<Item[]>("list_items");
    } catch (err) {
      console.error(`list_items failed (attempt ${attempt + 1})`, err);
      await sleep(400 * (attempt + 1));
    }
  }
  if (fetched === null) {
    $("#outline").innerHTML = `<div class="error">Couldn't load notes. <a id="retry-items">Retry</a></div>`;
    $("#retry-items").addEventListener("click", () => loadItems());
    return;
  }
  if (dirty) {
    // Keep unsaved local text edits for rows the backend still has.
    for (const f of fetched) {
      const local = byId(f.id);
      if (local) Object.assign(f, { text: local.text, kind: local.kind, done: local.done, schedule: local.schedule });
    }
  }
  items = fetched;
  loaded = true;
  render();
}

// ---------- caret helpers ----------

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length;
}

// ---------- links ----------
// A row shows its URLs as links while it is not being edited. Editing happens
// on plain text (contenteditable=plaintext-only needs a single text node for
// the caret helpers), so a row is flattened on mousedown/focus and linkified
// again on blur. Clicking a link opens it without starting an edit.

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML for `text` with URLs wrapped in anchors; trailing punctuation stays text. */
export function linkify(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (!url) continue;
    const start = m.index!;
    out += escapeHtml(text.slice(last, start));
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    out += `<a href="${escapeHtml(href)}" data-ext title="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Show the row's text with clickable links (display mode). */
function showLinked(txt: HTMLElement, text: string) {
  if (document.activeElement === txt) {
    txt.textContent = text;
    return;
  }
  txt.innerHTML = linkify(text);
  txt.querySelectorAll<HTMLAnchorElement>("a[data-ext]").forEach((a) => {
    a.addEventListener("mousedown", (e) => e.preventDefault());
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUrl(a.href).catch((err) => console.error("openUrl failed", err));
    });
  });
}

/** Collapse the row to a single text node so editing and caret math work. */
function plainText(el: HTMLElement) {
  if (el.firstElementChild) el.textContent = el.textContent;
}

function setCaret(el: HTMLElement, pos: number | "end") {
  plainText(el);
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const node = el.firstChild;
  if (!node) {
    range.setStart(el, 0);
  } else {
    const len = node.textContent?.length ?? 0;
    range.setStart(node, pos === "end" ? len : Math.min(pos, len));
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Is the caret on the first/last visual line of a wrapped row? */
function caretOnEdgeLine(el: HTMLElement, edge: "first" | "last"): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.firstChild) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  const r = rects[0] ?? el.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return edge === "first" ? r.top - box.top < line * 0.6 : box.bottom - r.bottom < line * 0.6;
}

// ---------- rendering ----------

function render() {
  const el = $("#outline");
  // A reload from the backend (capture popup, scheduling) must not steal the
  // caret from a row being typed in.
  if (!pendingFocus) {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>("#outline .row");
    if (active && row && active.classList.contains("txt")) {
      pendingFocus = { id: row.classList.contains("new") ? "new" : Number(row.dataset.id), caret: caretOffset(active) };
    }
  }
  const frag = document.createDocumentFragment();
  // Drop folds for parents that no longer exist or have no children.
  for (const id of [...collapsed]) {
    if (!byId(id) || !items.some((c) => c.parent === id)) collapsed.delete(id);
  }
  for (const it of visibleItems()) frag.appendChild(renderRow(it));
  frag.appendChild(renderNewRow());
  el.replaceChildren(frag);

  const open = items.filter((i) => i.kind === "task" && !i.done).length;
  const done = items.filter((i) => i.kind === "task" && i.done).length;
  $("#task-count").textContent = open ? String(open) : "";
  const clearBtn = $<HTMLButtonElement>("#btn-clear-done");
  clearBtn.hidden = done === 0;
  clearBtn.textContent = done === 1 ? "archive 1 completed" : `archive ${done} completed`;
  refreshArchiveLink();

  if (pendingFocus) {
    const target = pendingFocus.id === "new" ? el.querySelector<HTMLElement>(".row.new .txt") : el.querySelector<HTMLElement>(`.row[data-id="${pendingFocus.id}"] .txt`);
    if (target) setCaret(target, pendingFocus.caret);
    pendingFocus = null;
  }
}

function rowClass(it: Item) {
  const kids = it.parent === null && items.some((c) => c.parent === it.id);
  return `row ${it.kind}${it.done ? " done" : ""}${it.parent !== null ? " child" : ""}${kids ? " parent" : ""}${kids && collapsed.has(it.id) ? " collapsed" : ""}${it.schedule ? " scheduled" : ""}`;
}

// ---------- scheduling ----------

/** Rows with a calendar request in flight, so a blur right after Enter can't double up. */
const scheduling = new Set<number>();
/** Why the last calendar call for a row failed, for the badge tooltip. */
const scheduleErrors = new Map<number, string>();

/** If the row's text names a date/time, strip it and make the row a task.
 *  Returns the parsed window; the caller then calls `commitSchedule`. */
function detectSchedule(it: Item): Parsed | null {
  if (scheduling.has(it.id)) return null;
  const p = parseSchedule(it.text);
  if (!p) return null;
  it.text = p.title;
  it.kind = "task";
  scheduleSave();
  return p;
}

/** Ask the backend to put the row on the calendar and show the result on its badge. */
async function commitSchedule(it: Item, p: Parsed) {
  scheduling.add(it.id);
  try {
    await flushSave();
    const updated = await invoke<Item>("schedule_item", { id: it.id, start: p.start, end: p.end, allDay: p.allDay });
    const local = byId(it.id);
    if (local) local.schedule = updated.schedule;
    scheduleErrors.delete(it.id);
  } catch (err) {
    console.error("schedule_item failed", err);
    // Keep the time locally so nothing the user typed is lost; the badge
    // shows it isn't on the calendar and why.
    const local = byId(it.id);
    if (local) local.schedule = { start: p.start, end: p.end, all_day: p.allDay, event_id: null };
    scheduleErrors.set(it.id, String(err));
    scheduleSave();
  } finally {
    scheduling.delete(it.id);
  }
  refreshRow(it.id);
}

async function unschedule(it: Item) {
  if (scheduling.has(it.id)) return;
  scheduling.add(it.id);
  try {
    await flushSave();
    const updated = await invoke<Item>("unschedule_item", { id: it.id });
    const local = byId(it.id);
    if (local) local.schedule = updated.schedule;
    scheduleErrors.delete(it.id);
  } catch (err) {
    console.error("unschedule_item failed", err);
    scheduleErrors.set(it.id, String(err));
  } finally {
    scheduling.delete(it.id);
  }
  refreshRow(it.id);
}

/** Calendar badge after the text: when it is, and a ✕ to take it off the calendar. */
function renderWhen(it: Item): HTMLElement {
  const s = it.schedule!;
  const el = document.createElement("span");
  const past = s.end < Date.now() / 1000;
  el.className = `when${s.event_id ? "" : " off"}${past ? " past" : ""}`;
  const long = fmtScheduleLong(s.start, s.end, s.all_day);
  const err = scheduleErrors.get(it.id);
  el.title = s.event_id ? `On your calendar: ${long}` : `Not on your calendar${err ? ` (${err})` : ""}: ${long}`;
  const text = document.createElement("span");
  text.className = "when-text";
  text.textContent = fmtSchedule(s.start, s.all_day);
  const x = document.createElement("button");
  x.className = "when-x";
  x.tabIndex = -1;
  x.title = "Remove from calendar";
  x.textContent = "×";
  x.addEventListener("mousedown", (e) => e.preventDefault());
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    unschedule(it);
  });
  el.append(text, x);
  return el;
}

/** Update one row in place (class, text, checkbox, badge) without rebuilding
 *  the list, so the caret stays wherever the user is typing. */
function refreshRow(id: number) {
  const it = byId(id);
  const row = document.querySelector<HTMLElement>(`#outline .row[data-id="${id}"]`);
  if (!it || !row) return;
  row.className = rowClass(it);
  const txt = row.querySelector<HTMLElement>(".txt");
  if (txt && document.activeElement !== txt) showLinked(txt, it.text);
  const mark = row.querySelector<HTMLElement>(".mark");
  if (mark) {
    mark.innerHTML = it.kind === "task" ? CHECK : "";
    if (it.kind === "task") mark.title = it.done ? "Mark not done" : "Mark done";
  }
  row.querySelector(".when")?.remove();
  if (it.schedule && txt) txt.after(renderWhen(it));
}

function renderRow(it: Item): HTMLElement {
  const row = document.createElement("div");
  row.className = rowClass(it);
  row.dataset.id = String(it.id);

  const mark = document.createElement("button");
  mark.className = "mark";
  mark.tabIndex = -1;
  mark.title = it.kind === "task" ? (it.done ? "Mark not done" : "Mark done") : "Turn into a task";
  mark.innerHTML = it.kind === "task" ? `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>` : "";
  const kidCount = childrenOf(it.id).length;
  if (kidCount && it.kind === "note") mark.title = collapsed.has(it.id) ? `Expand ${kidCount} nested` : "Collapse";
  mark.addEventListener("mousedown", (e) => e.preventDefault());
  mark.addEventListener("click", () => {
    // A note bullet with children is a disclosure, like Workflowy. Task
    // checkboxes keep toggling done; their fold lives on the chevron.
    if (it.kind === "note" && kidCount) {
      toggleCollapsed(it.id);
      return;
    }
    if (it.kind === "task") it.done = !it.done;
    else it.kind = "task";
    row.className = rowClass(it);
    mark.title = it.done ? "Mark not done" : "Mark done";
    mark.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>`;
    scheduleSave();
    render();
  });

  const txt = document.createElement("div");
  txt.className = "txt";
  txt.contentEditable = "plaintext-only";
  txt.spellcheck = true;
  showLinked(txt, it.text);
  txt.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("a")) return;
    plainText(txt);
  });
  txt.addEventListener("focus", () => plainText(txt));
  txt.addEventListener("input", () => onInput(it, txt));
  txt.addEventListener("keydown", (e) => onKey(e, it, txt));
  txt.addEventListener("blur", () => {
    const p = detectSchedule(it);
    if (p) {
      refreshRow(it.id);
      void commitSchedule(it, p);
    }
    showLinked(txt, it.text);
    flushSave();
  });

  const del = document.createElement("button");
  del.className = "del";
  del.tabIndex = -1;
  del.title = kidCount ? `Archive (with ${kidCount} nested)` : "Archive";
  del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>`;
  del.addEventListener("mousedown", (e) => e.preventDefault());
  del.addEventListener("click", () => archive([it.id]));

  if (kidCount) row.appendChild(renderToggle(collapsed.has(it.id), kidCount, () => toggleCollapsed(it.id)));
  row.append(mark, txt);
  if (it.schedule) row.appendChild(renderWhen(it));
  if (kidCount && collapsed.has(it.id)) row.appendChild(renderCount(kidCount));
  row.appendChild(del);
  return row;
}

function renderNewRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "row new note";
  const mark = document.createElement("span");
  mark.className = "mark";
  const txt = document.createElement("div");
  txt.className = "txt";
  txt.contentEditable = "plaintext-only";
  txt.dataset.placeholder = items.length ? "Add a note…" : "Add a note… start with - or [] for a task";
  txt.addEventListener("input", () => {
    const raw = txt.textContent ?? "";
    if (!raw) return;
    const { text, kind } = parseMarker(raw);
    const it = newItem(text, null, kind ?? "note");
    items.push(it);
    pendingFocus = { id: it.id, caret: "end" };
    scheduleSave();
    render();
  });
  txt.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      const vis = visibleItems();
      pendingFocus = { id: vis[vis.length - 1].id, caret: "end" };
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
    } else if (e.key === "Escape") {
      txt.blur();
    }
  });
  row.append(mark, txt);
  return row;
}

// ---------- editing ----------

function onInput(it: Item, txt: HTMLElement) {
  const raw = txt.textContent ?? "";
  const { text, kind } = parseMarker(raw);
  if (kind && (kind !== it.kind || text !== raw)) {
    it.kind = kind;
    it.text = text;
    pendingFocus = { id: it.id, caret: "end" };
    scheduleSave();
    render();
    return;
  }
  it.text = raw;
  scheduleSave();
}

function onKey(e: KeyboardEvent, it: Item, txt: HTMLElement) {
  const i = idx(it.id);
  switch (e.key) {
    case "Enter": {
      e.preventDefault();
      if (e.ctrlKey) {
        it.kind = it.kind === "task" ? "note" : "task";
        pendingFocus = { id: it.id, caret: caretOffset(txt) };
        scheduleSave();
        render();
        return;
      }
      // Split at the caret: text after it moves to the new row.
      const at = caretOffset(txt);
      const after = it.text.slice(at);
      it.text = it.text.slice(0, at);
      // Committing a row with a date in it puts it on the calendar.
      const sched = detectSchedule(it);
      if (sched) void commitSchedule(it, sched);
      const hasChildren = it.parent === null && items[i + 1]?.parent === it.id;
      if (hasChildren) collapsed.delete(it.id);
      const next = newItem(after, hasChildren ? it.id : it.parent);
      items.splice(i + 1, 0, next);
      pendingFocus = { id: next.id, caret: 0 };
      scheduleSave();
      render();
      return;
    }
    case "Tab": {
      e.preventDefault();
      if (e.shiftKey) {
        if (it.parent === null) return;
        const parent = it.parent;
        remove(it.id);
        it.parent = null;
        items.splice(blockEnd(parent) + 1, 0, it);
      } else {
        if (it.parent !== null) return;
        let p = -1;
        for (let k = i - 1; k >= 0; k--) if (items[k].parent === null) { p = k; break; }
        if (p < 0) return;
        const parentId = items[p].id;
        // Our own children become siblings under the new parent (one level max).
        for (const c of items) if (c.parent === it.id) c.parent = parentId;
        it.parent = parentId;
      }
      pendingFocus = { id: it.id, caret: caretOffset(txt) };
      scheduleSave();
      render();
      return;
    }
    case "Backspace": {
      if (txt.textContent === "" || (caretOffset(txt) === 0 && !it.text)) {
        e.preventDefault();
        const vis = visibleItems();
        const prev = vis[vis.findIndex((v) => v.id === it.id) - 1];
        remove(it.id);
        pendingFocus = prev ? { id: prev.id, caret: "end" } : { id: "new", caret: 0 };
        scheduleSave();
        render();
      }
      return;
    }
    case "ArrowUp": {
      if (!caretOnEdgeLine(txt, "first")) return;
      const vis = visibleItems();
      const prev = vis[vis.findIndex((v) => v.id === it.id) - 1];
      if (!prev) return;
      e.preventDefault();
      focusRow(prev.id);
      return;
    }
    case "ArrowDown": {
      if (!caretOnEdgeLine(txt, "last")) return;
      e.preventDefault();
      const vis = visibleItems();
      const next = vis[vis.findIndex((v) => v.id === it.id) + 1];
      if (next) focusRow(next.id);
      else setCaret($(".row.new .txt"), 0);
      return;
    }
    case "Escape":
      txt.blur();
      return;
  }
}

function focusRow(id: number) {
  const el = document.querySelector<HTMLElement>(`.row[data-id="${id}"] .txt`);
  if (el) setCaret(el, "end");
}

// ---------- public ----------

export function clearCompleted() {
  return archive(items.filter((i) => i.kind === "task" && i.done).map((i) => i.id));
}

// ---------- archive view ----------

let archiveCount = 0;

async function refreshArchiveLink() {
  try {
    archiveCount = (await invoke<ArchivedItem[]>("list_archive")).length;
  } catch {
    archiveCount = 0;
  }
  const link = $<HTMLButtonElement>("#btn-archive");
  link.hidden = archiveCount === 0;
  link.textContent = `archive ${archiveCount}`;
}

export async function openArchive() {
  const modal = $("#archive");
  const list = $("#archive-list");
  modal.classList.remove("hidden");
  list.innerHTML = `<div class="empty">Loading…</div>`;
  let rows: ArchivedItem[] = [];
  try {
    rows = await invoke<ArchivedItem[]>("list_archive");
  } catch (err) {
    list.innerHTML = `<div class="error">Couldn't load archive: ${String(err)}</div>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = `<div class="empty">Nothing archived. Rows you ✕ and completed tasks you archive end up here.</div>`;
    $<HTMLButtonElement>("#btn-archive-empty").hidden = true;
    return;
  }
  $<HTMLButtonElement>("#btn-archive-empty").hidden = false;
  // Newest first, children grouped under their parent when both are archived.
  const byTime = [...rows].sort((a, b) => b.archived_at - a.archived_at || a.id - b.id);
  const ids = new Set(rows.map((r) => r.id));
  const ordered: ArchivedItem[] = [];
  for (const r of byTime) {
    if (r.parent !== null && ids.has(r.parent)) continue;
    ordered.push(r, ...byTime.filter((c) => c.parent === r.id));
  }
  // Every archived parent starts folded; clicking it reveals the nested rows.
  const expanded = new Set<number>();
  function rebuild() {
  const frag = document.createDocumentFragment();
  let lastDay = "";
  for (const r of ordered) {
    const isChild = r.parent !== null && ids.has(r.parent);
    if (isChild && !expanded.has(r.parent as number)) continue;
    const kids = isChild ? 0 : byTime.filter((c) => c.parent === r.id).length;
    const day = new Date(r.archived_at * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== lastDay && !isChild) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = day;
      frag.appendChild(sep);
      lastDay = day;
    }
    const row = document.createElement("div");
    row.className = `row arch ${r.kind}${r.done ? " done" : ""}${isChild ? " child" : ""}${kids ? " parent" : ""}${kids && !expanded.has(r.id) ? " collapsed" : ""}`;
    const mark = document.createElement("span");
    mark.className = "mark";
    if (r.kind === "task") mark.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>`;
    const txt = document.createElement("div");
    txt.className = "txt";
    if (r.text) showLinked(txt, r.text);
    else txt.textContent = "(empty)";
    if (kids) {
      // The whole row is the disclosure here: nothing in the archive is editable.
      const toggle = () => {
        if (expanded.has(r.id)) expanded.delete(r.id);
        else expanded.add(r.id);
        rebuild();
      };
      row.appendChild(renderToggle(!expanded.has(r.id), kids, toggle));
      row.classList.add("clickable");
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        toggle();
      });
    }
    const restore = document.createElement("button");
    restore.className = "mini";
    restore.title = "Restore to notes";
    restore.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 3v6h6" /></svg>`;
    restore.addEventListener("click", async () => {
      const group = [r.id, ...rows.filter((c) => c.parent === r.id).map((c) => c.id)];
      await invoke("restore_items", { ids: group }).catch((err) => console.error("restore failed", err));
      await loadItems();
      openArchive();
    });
    const del = document.createElement("button");
    del.className = "mini danger";
    del.title = "Delete permanently";
    del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>`;
    del.addEventListener("click", async () => {
      const group = [r.id, ...rows.filter((c) => c.parent === r.id).map((c) => c.id)];
      await invoke("delete_archived", { ids: group }).catch((err) => console.error("delete failed", err));
      refreshArchiveLink();
      openArchive();
    });
    row.append(mark, txt);
    if (kids && !expanded.has(r.id)) row.appendChild(renderCount(kids));
    row.append(restore, del);
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
  }
  rebuild();
}

export async function emptyArchive() {
  await invoke("delete_archived", { ids: [] }).catch((err) => console.error("delete failed", err));
  refreshArchiveLink();
  openArchive();
}

export function focusNewRow() {
  setCaret($(".row.new .txt"), 0);
}
