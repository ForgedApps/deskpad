import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderCloud, wireCloud } from "./cloud";
import { initImages } from "./images";
import { clearCompleted, focusItem, loadItems } from "./outline";
import { dayKey } from "./text";

interface Meeting {
  id: string;
  title: string;
  start: number;
  end: number;
  all_day: boolean;
  location: string | null;
  url: string | null;
}

interface Settings {
  google_client_id: string;
  google_client_secret: string;
  always_on_top: boolean;
  reserve_space: boolean;
  autostart: boolean;
  width: number;
  /** Today view also lists tomorrow's events starting before this hour (0 = off, 24 = all). */
  tomorrow_until_hour: number;
  show_all_day: boolean;
}

interface MeetingsResult {
  source: "google" | "none";
  meetings: Meeting[];
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let settings: Settings;
/** Today + tomorrow, refreshed every 5 min. Drives the Today view and the alerts. */
let meetings: Meeting[] = [];
/** Events for the day being browsed when it isn't today. */
let dayMeetings: Meeting[] = [];
/** 0 = today, -1 = yesterday, 1 = tomorrow, ... */
let dayOffset = 0;
let googleConnected = false;

/** Local time (unix seconds) at `hour` o'clock on today plus `offset` days.
 *  Goes through Date so DST-change days (23 or 25 hours) come out right. */
function atHour(offset: number, hour: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  d.setHours(hour);
  return Math.floor(d.getTime() / 1000);
}

/** Local midnight (unix seconds) of today plus `offset` days. */
const dayStart = (offset: number) => atHour(offset, 0);

function fmtHour(h: number): string {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric" });
}

// ---------- clock ----------

function tickClock() {
  const now = new Date();
  $("#clock-time").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("#clock-date").textContent = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ---------- meetings ----------

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function relative(m: Meeting, now: number): { label: string; cls: string } {
  if (m.all_day) return { label: "", cls: "" };
  if (now >= m.start && now < m.end) {
    const left = Math.ceil((m.end - now) / 60);
    return { label: `now · ${left}m left`, cls: "now" };
  }
  if (now >= m.end) return { label: "ended", cls: "past" };
  const mins = Math.round((m.start - now) / 60);
  if (mins < 60) return { label: `in ${mins}m`, cls: "soon" };
  const hrs = Math.floor(mins / 60);
  if (hrs < 12) return { label: `in ${hrs}h ${mins % 60}m`, cls: "" };
  return { label: "", cls: "" };
}

function dayLabel(offset: number) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return new Date(dayStart(offset) * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function joinLabel(url: string): string {
  if (/meet\.google\.com/.test(url)) return "Join Meet";
  if (/zoom\.us/.test(url)) return "Join Zoom";
  if (/teams\.microsoft\.com|teams\.live\.com/.test(url)) return "Join Teams";
  if (/calendar\.google\.com/.test(url)) return "Open in Calendar";
  return "Join";
}

/** Events that overlap the local day today + `offset`, honouring the all-day setting. */
function eventsOn(list: Meeting[], offset: number): Meeting[] {
  const start = dayStart(offset);
  const end = dayStart(offset + 1);
  return list.filter((m) => m.start < end && m.end > start && (settings.show_all_day || !m.all_day));
}

function renderCalHeader() {
  $("#cal-title").textContent = dayLabel(dayOffset);
  $("#cal-title").classList.toggle("other-day", dayOffset !== 0);
  $<HTMLButtonElement>("#btn-today").hidden = dayOffset === 0;
}

function renderMeetings() {
  const el = $("#meetings");
  const now = Math.floor(Date.now() / 1000);
  renderCalHeader();
  if (!googleConnected) {
    el.innerHTML = `<div class="empty">No calendar connected. <a id="link-settings">Connect Google Calendar</a> to see your day.</div>`;
    el.querySelector("#link-settings")?.addEventListener("click", openSettings);
    return;
  }
  const frag = document.createDocumentFragment();
  if (dayOffset === 0) {
    const today = eventsOn(meetings, 0);
    if (today.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No events today.";
      frag.appendChild(empty);
    }
    for (const m of today) frag.appendChild(renderMeeting(m, now, false));

    // Early tomorrow, so a first-thing meeting is never a surprise.
    const until = settings.tomorrow_until_hour;
    if (until > 0) {
      const cutoff = atHour(1, until);
      const early = eventsOn(meetings, 1).filter((m) => m.start < cutoff);
      if (early.length) {
        const sep = document.createElement("div");
        sep.className = "day-sep tomorrow";
        sep.textContent = until >= 24 ? "Tomorrow" : `Tomorrow · before ${fmtHour(until)}`;
        frag.appendChild(sep);
        for (const m of early) frag.appendChild(renderMeeting(m, now, true));
      }
    }
  } else {
    const list = eventsOn(dayMeetings, dayOffset);
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = dayOffset === 1 ? "No events tomorrow." : dayOffset === -1 ? "No events yesterday." : `No events on ${dayLabel(dayOffset)}.`;
      frag.appendChild(empty);
    }
    for (const m of list) frag.appendChild(renderMeeting(m, now, false));
  }
  el.replaceChildren(frag);
  el.querySelectorAll<HTMLAnchorElement>("a[data-ext]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(a.href);
    }),
  );
}

function renderMeeting(m: Meeting, now: number, nextDay: boolean): HTMLElement {
    const rel = relative(m, now);
    const card = document.createElement("div");
    card.className = `meeting ${rel.cls}${nextDay ? " next-day" : ""}`;
    const when = m.all_day ? "all day" : fmtTime(m.start);
    const range = m.all_day ? "All day" : `${fmtTime(m.start)} – ${fmtTime(m.end)}`;
    const loc = m.location && !m.location.startsWith("http") ? `\n${m.location}` : "";
    card.title = `${range}${loc}`;
    card.innerHTML = `
      <span class="m-when">${when}</span>
      <span class="m-title"></span>
      <span class="m-rel">${rel.label}</span>
      ${m.url ? `<a class="m-join" href="${m.url.replace(/"/g, "&quot;")}" data-ext title="${joinLabel(m.url)}"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M21 3l-9 9M10 5H5v14h14v-5" /></svg></a>` : ""}
    `;
    card.querySelector(".m-title")!.textContent = m.title;
    return card;
}

/** Fetch today + tomorrow (alerts and the Today view), plus the browsed day if it's another one. */
async function loadMeetings(_force = false) {
  if (!googleConnected) {
    meetings = [];
    dayMeetings = [];
    renderMeetings();
    return;
  }
  const btn = $("#btn-refresh");
  btn.classList.add("spin");
  try {
    const base = invoke<MeetingsResult>("get_meetings", { from: dayStart(0), to: dayStart(2) });
    const extra =
      dayOffset === 0 ? null : invoke<MeetingsResult>("get_meetings", { from: dayStart(dayOffset), to: dayStart(dayOffset + 1) });
    const [b, e] = await Promise.all([base, extra]);
    meetings = b.meetings;
    if (e) dayMeetings = e.meetings;
    renderMeetings();
    checkAlerts();
    recordDays();
  } catch (err) {
    $("#meetings").innerHTML = `<div class="error">Couldn't load calendar: ${String(err)}</div>`;
  } finally {
    btn.classList.remove("spin");
  }
}

let dayLoadSeq = 0;

/** Hand the backend each fetched day's events so the journal can show past
 *  days even when Google isn't reachable. Today and tomorrow from `meetings`,
 *  plus the browsed day when it is another one. */
function recordDays() {
  const record = (offset: number, list: Meeting[]) => {
    const start = dayStart(offset);
    const end = dayStart(offset + 1);
    const evs = list.filter((m) => m.start < end && m.end > start);
    invoke("record_day_events", { day: dayKey(start), meetings: evs }).catch((err) => console.error("record_day_events failed", err));
  };
  record(0, meetings);
  record(1, meetings);
  if (dayOffset !== 0) record(dayOffset, dayMeetings);
}

/** Browse another day; a quick succession of clicks only fetches the last one. */
async function showDay(offset: number) {
  dayOffset = offset;
  renderCalHeader();
  if (offset === 0 || !googleConnected) {
    renderMeetings();
    return;
  }
  const seq = ++dayLoadSeq;
  $("#meetings").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const r = await invoke<MeetingsResult>("get_meetings", { from: dayStart(offset), to: dayStart(offset + 1) });
    if (seq !== dayLoadSeq) return;
    dayMeetings = r.meetings;
    renderMeetings();
    recordDays();
  } catch (err) {
    if (seq !== dayLoadSeq) return;
    $("#meetings").innerHTML = `<div class="error">Couldn't load calendar: ${String(err)}</div>`;
  }
}

// ---------- add event ----------

function toggleEventForm(open?: boolean) {
  const form = $<HTMLFormElement>("#event-form");
  const show = open ?? form.hidden;
  form.hidden = !show;
  if (!show) return;
  $("#ev-error").textContent = googleConnected ? "" : "Connect Google Calendar in Settings to add events.";
  const now = new Date(Date.now() + 15 * 60_000);
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  if (dayOffset !== 0) now.setDate(now.getDate() + dayOffset);
  const pad = (n: number) => String(n).padStart(2, "0");
  $<HTMLInputElement>("#ev-date").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $<HTMLInputElement>("#ev-time").value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $<HTMLInputElement>("#ev-title").value = "";
  $<HTMLInputElement>("#ev-title").focus();
}

async function submitEvent(e: Event) {
  e.preventDefault();
  const errEl = $("#ev-error");
  const title = $<HTMLInputElement>("#ev-title").value.trim();
  const date = $<HTMLInputElement>("#ev-date").value;
  const time = $<HTMLInputElement>("#ev-time").value;
  const duration = Number($<HTMLSelectElement>("#ev-duration").value);
  if (!title) return void (errEl.textContent = "Give the event a title.");
  if (!date || !time) return void (errEl.textContent = "Pick a date and time.");
  const start = Math.floor(new Date(`${date}T${time}`).getTime() / 1000);
  const btn = $<HTMLButtonElement>("#event-form button[type=submit]");
  btn.disabled = true;
  errEl.textContent = "";
  try {
    const created = await invoke<Meeting>("create_event", { title, start, durationMin: duration });
    meetings = [...meetings, created].sort((a, b) => a.start - b.start || a.end - b.end);
    renderMeetings();
    toggleEventForm(false);
    loadMeetings(true);
  } catch (err) {
    errEl.textContent = String(err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- meeting alerts ----------

/** Seconds before the start at which the full-screen alert appears. */
const ALERT_LEAD = 2 * 60;
/** Don't alert for something that started more than this long ago. */
const ALERT_GRACE = 5 * 60;

interface AlertState {
  shown: boolean;
  dismissed: boolean;
  snoozedUntil: number;
}
const alerts = new Map<string, AlertState>();

function checkAlerts() {
  const now = Math.floor(Date.now() / 1000);
  const dueNow = meetings.filter(
    (m) => !m.all_day && now >= m.start - ALERT_LEAD && now < Math.min(m.end, m.start + ALERT_GRACE),
  );
  for (const m of dueNow) {
    const st = alerts.get(m.id) ?? { shown: false, dismissed: false, snoozedUntil: 0 };
    if (st.dismissed || st.shown || st.snoozedUntil > now) continue;
    st.shown = true;
    alerts.set(m.id, st);
    invoke("show_alert", { meeting: m }).catch((err) => {
      console.error("show_alert failed", err);
      st.shown = false;
    });
    break; // one alert at a time; the next shows after this one is handled
  }
  // Forget state for meetings that are long gone.
  for (const [id, st] of alerts) {
    const m = meetings.find((x) => x.id === id);
    if (!m || now > m.end + 3600) {
      if (!st.shown) alerts.delete(id);
    }
  }
}

function onAlertAction(a: { id: string; action: string; minutes: number }) {
  const st = alerts.get(a.id) ?? { shown: false, dismissed: false, snoozedUntil: 0 };
  st.shown = false;
  if (a.action === "dismiss") st.dismissed = true;
  else if (a.action === "snooze") st.snoozedUntil = Math.floor(Date.now() / 1000) + Math.max(1, a.minutes) * 60;
  alerts.set(a.id, st);
}

// ---------- settings ----------

function renderGoogleState() {
  $("#google-connected").classList.toggle("hidden", !googleConnected);
  $("#google-disconnected").classList.toggle("hidden", googleConnected);
}

function openSettings() {
  $<HTMLInputElement>("#s-gid").value = settings.google_client_id;
  $<HTMLInputElement>("#s-gsecret").value = settings.google_client_secret;
  $<HTMLSelectElement>("#s-tomorrow").value = String(settings.tomorrow_until_hour);
  $<HTMLInputElement>("#s-width").value = String(settings.width);
  $<HTMLInputElement>("#s-allday").checked = settings.show_all_day;
  $<HTMLInputElement>("#s-reserve").checked = settings.reserve_space;
  $<HTMLInputElement>("#s-top").checked = settings.always_on_top;
  $<HTMLInputElement>("#s-autostart").checked = settings.autostart;
  $("#google-error").textContent = "";
  $("#settings-error").textContent = "";
  $("#settings-saved").textContent = "";
  renderGoogleState();
  void renderCloud();
  $("#settings").classList.remove("hidden");
}

function readSettingsForm(): Settings {
  return {
    google_client_id: $<HTMLInputElement>("#s-gid").value.trim(),
    google_client_secret: $<HTMLInputElement>("#s-gsecret").value.trim(),
    tomorrow_until_hour: Math.min(24, Math.max(0, Number($<HTMLSelectElement>("#s-tomorrow").value) || 0)),
    width: Math.min(600, Math.max(240, Number($<HTMLInputElement>("#s-width").value) || 340)),
    show_all_day: $<HTMLInputElement>("#s-allday").checked,
    reserve_space: $<HTMLInputElement>("#s-reserve").checked,
    always_on_top: $<HTMLInputElement>("#s-top").checked,
    autostart: $<HTMLInputElement>("#s-autostart").checked,
  };
}

// Settings save themselves: every control writes the whole form as soon as it
// changes, so the dialog only needs a way to close.
let savedNoteTimer = 0;
let saveChain: Promise<void> = Promise.resolve();

function saveSettings() {
  const next = readSettingsForm();
  // One write at a time, in order, so a quick second change can't land first.
  saveChain = saveChain.then(async () => {
    try {
      await invoke("set_settings", { settings: next });
    } catch (err) {
      $("#settings-error").textContent = String(err);
      return;
    }
    $("#settings-error").textContent = "";
    const calendarChanged = next.tomorrow_until_hour !== settings.tomorrow_until_hour || next.show_all_day !== settings.show_all_day;
    settings = next;
    const note = $("#settings-saved");
    note.textContent = "Saved";
    window.clearTimeout(savedNoteTimer);
    savedNoteTimer = window.setTimeout(() => (note.textContent = ""), 1500);
    if (calendarChanged) loadMeetings(true);
  });
}

function closeSettings() {
  $("#settings").classList.add("hidden");
}

async function connectGoogle() {
  const btn = $<HTMLButtonElement>("#btn-google-connect");
  const errEl = $("#google-error");
  errEl.textContent = "";
  // Persist the client credentials first so the backend can use them.
  const next = readSettingsForm();
  if (!next.google_client_id) {
    errEl.textContent = "Enter the OAuth client ID first.";
    return;
  }
  await invoke("set_settings", { settings: next });
  settings = next;
  btn.disabled = true;
  btn.textContent = "Waiting for sign-in in your browser…";
  try {
    await invoke("google_connect");
    googleConnected = true;
    renderGoogleState();
    loadMeetings(true);
  } catch (err) {
    errEl.textContent = String(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect Google Calendar";
  }
}

async function disconnectGoogle() {
  await invoke("google_disconnect");
  googleConnected = false;
  renderGoogleState();
  loadMeetings(true);
}

// ---------- boot ----------

function wireUi() {
  $("#btn-capture").addEventListener("click", () => invoke("show_capture"));
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-hide").addEventListener("click", () => invoke("hide_sidebar"));
  $("#btn-google-connect").addEventListener("click", connectGoogle);
  $("#btn-google-disconnect").addEventListener("click", disconnectGoogle);
  wireCloud();
  $("#btn-refresh").addEventListener("click", () => loadMeetings(true));
  $("#btn-prev-day").addEventListener("click", () => showDay(dayOffset - 1));
  $("#btn-next-day").addEventListener("click", () => showDay(dayOffset + 1));
  $("#btn-today").addEventListener("click", () => showDay(0));
  // Hour choices for the "show tomorrow before" setting.
  const sel = $<HTMLSelectElement>("#s-tomorrow");
  const opt = (v: number, label: string) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = label;
    sel.appendChild(o);
  };
  opt(0, "Never show tomorrow");
  for (let h = 5; h <= 18; h++) opt(h, fmtHour(h));
  opt(24, "Show all of tomorrow");
  $("#btn-add-event").addEventListener("click", () => toggleEventForm());
  $("#ev-cancel").addEventListener("click", () => toggleEventForm(false));
  $("#event-form").addEventListener("submit", submitEvent);
  $("#btn-clear-done").addEventListener("click", () => clearCompleted());
  $("#btn-journal").addEventListener("click", () => invoke("open_journal").catch((err) => console.error("open_journal failed", err)));
  // Enter in a field must not submit the page away; changes save on their own.
  $("#settings-form").addEventListener("submit", (e) => e.preventDefault());
  $("#settings-form").addEventListener("change", (e) => {
    if ((e.target as HTMLElement).closest("input, select")) saveSettings();
  });
  $("#btn-settings-close").addEventListener("click", closeSettings);
  $("#btn-settings-x").addEventListener("click", closeSettings);
  $("#btn-quit").addEventListener("click", () => invoke("quit"));
  $("#settings").addEventListener("click", (e) => {
    if (e.target === $("#settings")) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSettings();
      toggleEventForm(false);
    }
  });
}

const nativeError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  nativeError(...args);
  invoke("log_js", { msg: args.map((a) => (a instanceof Error ? `${a.message}
${a.stack ?? ""}` : String(a))).join(" ") }).catch(() => {});
};
window.addEventListener("error", (e) => invoke("log_js", { msg: `error: ${e.message} @${e.filename}:${e.lineno}` }).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => invoke("log_js", { msg: `unhandled: ${String(e.reason)}` }).catch(() => {}));

window.addEventListener("DOMContentLoaded", async () => {
  // Wire every control first, synchronously, so a slow or failed backend call
  // can never leave the UI inert (or let the task form do a native submit).
  wireUi();
  tickClock();
  setInterval(tickClock, 1000);

  // Retry rather than fall back to defaults: a failed load must never look
  // like an unconfigured app, and nothing below runs until settings are real.
  for (let attempt = 0; ; attempt++) {
    try {
      [settings, googleConnected] = await Promise.all([
        invoke<Settings>("get_settings"),
        invoke<boolean>("google_status"),
      ]);
      break;
    } catch (err) {
      console.error(`failed to load settings (attempt ${attempt + 1})`, err);
      if (attempt === 0) $("#meetings").innerHTML = `<div class="error">Connecting to Deskpad…</div>`;
      await new Promise((r) => setTimeout(r, Math.min(5000, 400 * (attempt + 1))));
    }
  }

  // Pictures need the images folder before rows render; the call is local and quick.
  await initImages();
  loadItems().catch((err) => console.error("loadItems failed", err));
  loadMeetings().catch((err) => console.error("loadMeetings failed", err));

  // Re-render relative times every 30s, refetch the feed every 5 min,
  // check for meetings about to start every 5s.
  let renderedDay = dayStart(0);
  setInterval(() => {
    if (dayStart(0) !== renderedDay) {
      renderedDay = dayStart(0);
      loadMeetings();
    } else renderMeetings();
  }, 30_000);
  setInterval(checkAlerts, 5_000);
  setInterval(() => loadMeetings(), 5 * 60_000);

  listen("items-changed", () => loadItems()).catch((err) => console.error("listen failed", err));
  listen<number>("focus-item", (e) => focusItem(e.payload)).catch((err) => console.error("listen failed", err));
  // A task was put on (or taken off) the calendar from the outline or capture.
  listen("calendar-changed", () => loadMeetings(true)).catch((err) => console.error("listen failed", err));
  listen("open-settings", () => openSettings()).catch((err) => console.error("listen failed", err));
  listen<{ id: string; action: string; minutes: number }>("alert-action", (e) => onAlertAction(e.payload)).catch((err) =>
    console.error("listen failed", err),
  );
});
