// Full-screen meeting alert. The sidebar decides when to show it and sends the
// meeting via the "alert-show" event; every button reports back through
// `alert_action`, which hides this window and notifies the sidebar.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Meeting {
  id: string;
  title: string;
  start: number;
  end: number;
  all_day: boolean;
  location: string | null;
  url: string | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let current: Meeting | null = null;
let timer: number | undefined;

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function tick() {
  if (!current) return;
  const now = Date.now() / 1000;
  const diff = Math.round(current.start - now);
  const el = $("#alert-countdown");
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (diff > 0) {
    el.textContent = `Starts in ${mmss(diff)}`;
    el.classList.remove("now");
  } else if (now < current.end) {
    el.textContent = diff > -60 ? "Starting now" : `Started ${mmss(-diff)} ago`;
    el.classList.add("now");
  } else {
    el.textContent = "Ended";
    el.classList.remove("now");
  }
}

function show(m: Meeting) {
  current = m;
  $("#alert-title").textContent = m.title;
  $("#alert-when").textContent = m.all_day ? "All day" : `${fmtTime(m.start)} – ${fmtTime(m.end)}`;
  const loc = m.location && !m.location.startsWith("http") ? m.location : "";
  $("#alert-loc").textContent = loc;
  $("#alert-loc").hidden = !loc;
  const join = $<HTMLButtonElement>("#alert-join");
  join.hidden = !m.url;
  if (m.url) {
    join.textContent = /meet\.google\.com/.test(m.url)
      ? "Join Meet"
      : /zoom\.us/.test(m.url)
        ? "Join Zoom"
        : /teams\.microsoft\.com|teams\.live\.com/.test(m.url)
          ? "Join Teams"
          : /calendar\.google\.com/.test(m.url)
            ? "Open in Calendar"
            : "Join";
  }
  tick();
  window.clearInterval(timer);
  timer = window.setInterval(tick, 1000);
  // Dismiss is the default: a stray Enter or Space must not open a meeting.
  $<HTMLButtonElement>("#alert-dismiss").focus();
}

function act(action: "dismiss" | "snooze", minutes = 0) {
  if (!current) return;
  const id = current.id;
  current = null;
  window.clearInterval(timer);
  invoke("alert_action", { action: { id, action, minutes } }).catch((err) => console.error("alert_action failed", err));
}

function join() {
  if (current?.url) openUrl(current.url).catch((err) => console.error("open failed", err));
  act("dismiss");
}

window.addEventListener("DOMContentLoaded", () => {
  $("#alert-join").addEventListener("click", join);
  $("#alert-snooze-1").addEventListener("click", () => act("snooze", 1));
  $("#alert-snooze-5").addEventListener("click", () => act("snooze", 5));
  $("#alert-dismiss").addEventListener("click", () => act("dismiss"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") act("dismiss");
    else if (e.key === "Enter" && document.activeElement?.tagName !== "BUTTON") act("dismiss");
  });
  listen<Meeting>("alert-show", (e) => show(e.payload)).catch((err) => console.error("listen failed", err));
  // Exposed for manual testing in a plain browser (no Tauri events there).
  (window as unknown as { __alertShow: typeof show }).__alertShow = show;
});
