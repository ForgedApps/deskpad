// Workflowy-style outline: every row is a note by default, becomes a task via
// a marker (`- `, `[]`, `/task`) or Ctrl+Enter, and nests to any depth under
// the row above it with Tab. Rows are stored in pre-order (a row is followed by
// all of its descendants); `normalize` restores that after a load. The frontend
// owns ordering; after every change the whole list is sent to the backend with
// `set_items`.
//
// Text is plain with a Markdown subset for formatting (see `renderInline`):
// a row shows the formatting while it isn't being edited and the raw markers
// while it is. Pasting rich text converts it (`parseClipboard`): list items
// become nested rows, bold/italic/links become markers.
//
// A row whose text names a date or time ("meet tom next friday at 10am") is
// scheduled when it is committed (Enter or leaving the row): the phrase is
// removed, the row becomes a task, and the backend puts it on the Google
// calendar. The badge after the text shows when; its ✕ takes it off again.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fmtSchedule, fmtScheduleLong, parseMarker, parseSchedule, type Parsed } from "./schedule";
import { renderInline } from "./text";
import { parseClipboard, type PastedLine } from "./paste";
import { clipboardImage, saveImage } from "./images";

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
  /** When the task was last marked done; null when open. */
  done_at: number | null;
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

function depthOf(it: Item): number {
  let d = 0;
  let p = it.parent;
  for (let guard = 0; p !== null && guard < 1000; guard++) {
    const q = byId(p);
    if (!q) break;
    d++;
    p = q.parent;
  }
  return d;
}

/** Ids of every row nested under `id`, at any depth. */
function descendants(id: number): Set<number> {
  const set = new Set<number>([id]);
  for (let k = idx(id) + 1; k < items.length; k++) {
    const p = items[k].parent;
    if (p !== null && set.has(p)) set.add(items[k].id);
    else break;
  }
  set.delete(id);
  return set;
}

/** Put rows in pre-order and make rows whose parent is missing (or part of a
 *  cycle) top-level. Data from older builds or a hand-edited file stays usable. */
function normalize(list: Item[]): Item[] {
  const ids = new Set(list.map((i) => i.id));
  for (const i of list) if (i.parent !== null && (i.parent === i.id || !ids.has(i.parent))) i.parent = null;
  const out: Item[] = [];
  const seen = new Set<number>();
  const emit = (parent: number | null) => {
    for (const i of list) {
      if (i.parent === parent && !seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
        emit(i.id);
      }
    }
  };
  emit(null);
  for (const i of list) {
    if (!seen.has(i.id)) {
      i.parent = null;
      seen.add(i.id);
      out.push(i);
    }
  }
  return out;
}

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

/** Rows currently shown, i.e. everything except what sits under a folded row. */
function visibleItems(): Item[] {
  const hidden = new Set<number>();
  const out: Item[] = [];
  for (const i of items) {
    if (i.parent !== null && (collapsed.has(i.parent) || hidden.has(i.parent))) {
      hidden.add(i.id);
      continue;
    }
    out.push(i);
  }
  return out;
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

/** Index of the last row in `id`'s block: itself, or its last descendant. */
function blockEnd(id: number): number {
  return idx(id) + descendants(id).size;
}

/** Take a row and its descendants out of the list; returns them in order. */
function spliceBlock(id: number): Item[] {
  const i = idx(id);
  return items.splice(i, blockEnd(id) - i + 1);
}

function newItem(text: string, parent: number | null, kind: "note" | "task" = "note"): Item {
  return { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), text, kind, done: false, parent, created_at: Math.floor(Date.now() / 1000), done_at: null, schedule: null };
}

const CHECK = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>`;

function remove(id: number) {
  // Children move up a level so nothing is orphaned.
  const it = byId(id);
  for (const i of items) if (i.parent === id) i.parent = it?.parent ?? null;
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
      if (local) Object.assign(f, { text: local.text, kind: local.kind, done: local.done, done_at: local.done_at, schedule: local.schedule });
    }
  }
  items = normalize(fetched);
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

// ---------- display vs edit ----------
// A row shows its formatting (links, bold, …) while it is not being edited.
// Editing happens on the raw text (contenteditable=plaintext-only needs a
// single text node for the caret helpers), so a row is flattened to its raw
// text on mousedown/focus and rendered again on blur. Clicking a link opens it
// without starting an edit.

/** Show the row's text rendered (display mode); the raw text is kept on the element. */
function showLinked(txt: HTMLElement, text: string) {
  txt.dataset.raw = text;
  if (document.activeElement === txt) {
    txt.textContent = text;
    return;
  }
  txt.innerHTML = renderInline(text);
  txt.querySelectorAll<HTMLAnchorElement>("a[data-ext]").forEach((a) => {
    a.addEventListener("mousedown", (e) => e.preventDefault());
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUrl(a.href).catch((err) => console.error("openUrl failed", err));
    });
  });
}

/** Collapse the row to a single text node holding the raw text so editing and
 *  caret math work. A no-op while editing (there are no elements then). */
function plainText(el: HTMLElement) {
  if (el.firstElementChild) el.textContent = el.dataset.raw ?? el.textContent;
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
  for (const it of visibleItems()) frag.appendChild(renderRow(it, depthOf(it)));
  frag.appendChild(renderNewRow());
  el.replaceChildren(frag);

  const open = items.filter((i) => i.kind === "task" && !i.done).length;
  const done = items.filter((i) => i.kind === "task" && i.done).length;
  $("#task-count").textContent = open ? String(open) : "";
  const clearBtn = $<HTMLButtonElement>("#btn-clear-done");
  clearBtn.hidden = done === 0;
  clearBtn.textContent = done === 1 ? "archive 1 completed" : `archive ${done} completed`;

  if (pendingFocus) {
    const target = pendingFocus.id === "new" ? el.querySelector<HTMLElement>(".row.new .txt") : el.querySelector<HTMLElement>(`.row[data-id="${pendingFocus.id}"] .txt`);
    if (target) setCaret(target, pendingFocus.caret);
    pendingFocus = null;
  }
}

function rowClass(it: Item) {
  const kids = items.some((c) => c.parent === it.id);
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

function renderRow(it: Item, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = rowClass(it);
  row.dataset.id = String(it.id);
  row.style.setProperty("--depth", String(depth));

  const mark = document.createElement("button");
  mark.className = "mark";
  mark.tabIndex = -1;
  mark.title = it.kind === "task" ? (it.done ? "Mark not done" : "Mark done") : "Turn into a task";
  mark.innerHTML = it.kind === "task" ? `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>` : "";
  const kidCount = descendants(it.id).size;
  if (kidCount && it.kind === "note") mark.title = collapsed.has(it.id) ? `Expand ${kidCount} nested` : "Collapse";
  mark.addEventListener("mousedown", (e) => e.preventDefault());
  mark.addEventListener("click", () => {
    // A note bullet with children is a disclosure, like Workflowy. Task
    // checkboxes keep toggling done; their fold lives on the chevron.
    if (it.kind === "note" && kidCount) {
      toggleCollapsed(it.id);
      return;
    }
    if (it.kind === "task") {
      it.done = !it.done;
      it.done_at = it.done ? Math.floor(Date.now() / 1000) : null;
    } else it.kind = "task";
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
    // Links open and pictures stay pictures; clicking either doesn't start an edit.
    if ((e.target as HTMLElement).closest("a, img")) {
      e.preventDefault();
      return;
    }
    plainText(txt);
  });
  txt.addEventListener("focus", () => plainText(txt));
  txt.addEventListener("input", () => onInput(it, txt));
  txt.addEventListener("keydown", (e) => onKey(e, it, txt));
  txt.addEventListener("paste", (e) => onPaste(e, it, txt));
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
  txt.addEventListener("paste", (e) => onPaste(e, null, txt));
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
      // With children showing, the new row becomes the first child; otherwise
      // it follows the whole block as a sibling.
      const hasChildren = items[i + 1]?.parent === it.id && !collapsed.has(it.id);
      const next = newItem(after, hasChildren ? it.id : it.parent);
      items.splice(hasChildren ? i + 1 : blockEnd(it.id) + 1, 0, next);
      pendingFocus = { id: next.id, caret: 0 };
      scheduleSave();
      render();
      return;
    }
    case "Tab": {
      e.preventDefault();
      if (e.shiftKey) {
        // Outdent: become the sibling right after the current parent's block.
        if (it.parent === null) return;
        const parent = byId(it.parent);
        if (!parent) return;
        const block = spliceBlock(it.id);
        it.parent = parent.parent;
        items.splice(blockEnd(parent.id) + 1, 0, ...block);
      } else {
        // Indent under the previous sibling; our own children come along.
        let p = -1;
        for (let k = i - 1; k >= 0; k--) if (items[k].parent === it.parent) { p = k; break; }
        if (p < 0) return;
        const parentId = items[p].id;
        collapsed.delete(parentId);
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

// ---------- paste ----------

function onPaste(e: ClipboardEvent, it: Item | null, txt: HTMLElement) {
  const dt = e.clipboardData;
  if (!dt) return;
  const image = clipboardImage(dt);
  if (image) {
    e.preventDefault();
    void pasteImage(image, it, txt);
    return;
  }
  const plain = dt.getData("text/plain");
  const lines = parseClipboard(dt.getData("text/html"), plain);
  if (!lines.length) return;
  if (lines.length === 1 && !lines[0].kind) {
    // One line: goes in at the caret like typed text (keeps undo). Unless it
    // picked up formatting markers, the browser's own plain paste is fine.
    if (lines[0].text === plain.trim()) return;
    e.preventDefault();
    document.execCommand("insertText", false, lines[0].text);
    return;
  }
  e.preventDefault();
  insertLines(it, txt, lines);
}

/** Store a clipboard image and put its marker in the row at the caret. The row
 *  keeps focus meanwhile, so the marker lands where the caret was. */
async function pasteImage(file: File, it: Item | null, txt: HTMLElement) {
  let marker: string;
  try {
    marker = await saveImage(file);
  } catch (err) {
    console.error("save_image failed", err);
    return;
  }
  if (document.activeElement === txt) {
    document.execCommand("insertText", false, marker);
    return;
  }
  // Focus moved on while the image was saving: append to the row instead.
  if (it) {
    it.text = (it.text ? it.text + " " : "") + marker;
    refreshRow(it.id);
    flushSave();
  } else {
    txt.textContent = (txt.textContent ?? "") + marker;
    txt.dispatchEvent(new Event("input"));
  }
}

/** Put pasted lines into the outline: the first joins the row at the caret, the
 *  rest become rows after it, nested as the source was relative to this row. */
function insertLines(it: Item | null, txt: HTMLElement, lines: PastedLine[]) {
  const [first, ...rest] = lines;
  let anchor: Item;
  let after = "";
  if (it) {
    const at = caretOffset(txt);
    after = it.text.slice(at);
    it.text = it.text.slice(0, at) + first.text;
    if (first.kind) {
      it.kind = "task";
      it.done = first.done;
      it.done_at = first.done ? Math.floor(Date.now() / 1000) : null;
    } else if (!it.text.trim()) {
      const m = parseMarker(it.text);
      if (m.kind) {
        it.kind = m.kind;
        it.text = m.text;
      }
    }
    anchor = it;
  } else {
    const m = parseMarker(first.text);
    anchor = newItem(m.kind ? m.text : first.text, null, first.kind ?? m.kind ?? "note");
    anchor.done = first.done;
    items.push(anchor);
  }
  // Rows at each depth that later lines can nest under; depth 0 is the anchor's level.
  const byDepth: Item[] = [anchor];
  let last = anchor;
  let at = blockEnd(anchor.id) + 1;
  for (const line of rest) {
    const depth = Math.min(line.depth, byDepth.length - 1 + 1);
    const parent = depth === 0 ? anchor.parent : byDepth[depth - 1].id;
    const m = parseMarker(line.text);
    const row = newItem(m.kind ? m.text : line.text, parent, line.kind ?? m.kind ?? "note");
    if (line.kind && line.done) {
      row.done = true;
      row.done_at = Math.floor(Date.now() / 1000);
    }
    items.splice(at++, 0, row);
    byDepth.length = depth;
    byDepth[depth] = row;
    last = row;
  }
  if (after) last.text += after;
  for (const d of byDepth) if (d) collapsed.delete(d.id);
  pendingFocus = { id: last.id, caret: last.text.length - after.length };
  scheduleSave();
  render();
}

function focusRow(id: number) {
  const el = document.querySelector<HTMLElement>(`.row[data-id="${id}"] .txt`);
  if (el) setCaret(el, "end");
}

// ---------- public ----------

export function clearCompleted() {
  return archive(items.filter((i) => i.kind === "task" && i.done).map((i) => i.id));
}

// ---------- journal hand-off ----------

/** Bring one row into view and put the caret in it (the journal's "show in sidebar"). */
export function focusItem(id: number) {
  const it = byId(id);
  if (!it) return;
  let changed = false;
  for (let p = it.parent; p !== null; p = byId(p)?.parent ?? null) {
    if (collapsed.delete(p)) changed = true;
  }
  if (changed) saveCollapsed();
  pendingFocus = { id, caret: "end" };
  render();
  document.querySelector(`.row[data-id="${id}"]`)?.scrollIntoView({ block: "center" });
}
