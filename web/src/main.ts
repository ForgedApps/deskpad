// Deskpad for the web: the notes outline on a phone. The outline itself is the
// desktop's `src/outline.ts`, unchanged; the Tauri imports it makes are aliased
// to the shims in `./shim` at build time, and `store.ts` plays the backend.
// This file is the page around it: sign-in, the header, the sync indicator,
// and a toolbar that stands in for the keys a phone keyboard doesn't have.

import "../../src/styles.css";
import "./mobile.css";
import { initImages } from "../../src/images";
import { clearCompleted, loadItems } from "../../src/outline";
import * as store from "./store";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- sign-in ----------
// One way in: Google. Signing in and signing up are the same step.

/** What a failed return from Google means, in plain words. */
function explain(code: string | null): string {
  if (!code) return "";
  if (/signup|unable_to_create_user|forbidden/i.test(code)) return "This Deskpad server isn't taking new accounts.";
  if (/access_denied/i.test(code)) return "Google sign-in was cancelled.";
  return "Google sign-in didn't complete. Try again.";
}

function showSignIn(message = "") {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#signin").hidden = false;
  if (message) $("#signin-error").textContent = message;
}

function wireSignIn() {
  const btn = $<HTMLButtonElement>("#signin-google");
  const error = $("#signin-error");
  // Back from Google with a problem: say so, and tidy the address.
  const failed = new URLSearchParams(location.search).get("error");
  if (failed) {
    error.textContent = explain(failed);
    history.replaceState(null, "", "/");
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    error.textContent = "";
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/", errorCallbackURL: "/" }),
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as { url?: string; message?: string } | null;
      if (!res.ok || !data?.url) throw new Error(data?.message ?? "Google sign-in isn't set up on this server yet.");
      location.href = data.url;
    } catch (err) {
      error.textContent = err instanceof TypeError ? "You're offline. Connect and try again." : err instanceof Error ? err.message : String(err);
      btn.disabled = false;
    }
  });
  fetch("/api/v1/auth-methods")
    .then((r) => r.json())
    .then((m: { google?: boolean }) => {
      if (!m.google) {
        btn.disabled = true;
        error.textContent = "Google sign-in isn't set up on this server yet.";
      }
    })
    .catch(() => {});
}

async function signOut() {
  await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }).catch(() => {});
  // Notes must not linger in a browser nobody is signed in to.
  await store.wipe();
  location.reload();
}

// ---------- the app ----------

function renderStatus() {
  const s = store.getStatus();
  const dot = $("#sync-dot");
  dot.dataset.phase = s.phase;
  dot.title = s.phase === "idle" ? "In sync" : s.phase === "syncing" ? "Syncing…" : s.message;
  const banner = $("#banner");
  const show = s.phase === "error" || s.phase === "paused" || s.phase === "offline";
  banner.hidden = !show;
  banner.dataset.phase = s.phase;
  $("#banner-text").textContent = s.message;
  const action = $("#banner-action");
  action.hidden = s.phase !== "paused";
  if (s.phase === "paused") action.textContent = `Delete those ${s.massDelete} rows in the cloud too`;
}

/** The row being edited, if any. */
function activeTxt(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  return el && el.classList.contains("txt") && el.closest("#outline") ? el : null;
}

/** A phone keyboard has no Tab or Ctrl: send the outline the key it listens for. */
function key(txt: HTMLElement, k: string, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  txt.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
}

function wireToolbar() {
  const bar = $("#toolbar");
  let last: HTMLElement | null = null;
  const update = () => {
    const txt = activeTxt();
    if (txt) last = txt;
    bar.hidden = !txt;
  };
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => window.setTimeout(update, 0));

  // Keep the bar on top of the on-screen keyboard where the viewport doesn't shrink for it.
  const vv = window.visualViewport;
  const place = () => {
    if (!vv) return;
    bar.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`;
  };
  vv?.addEventListener("resize", place);
  vv?.addEventListener("scroll", place);

  // Tapping a button must not take focus (and the keyboard) away from the row.
  bar.addEventListener("pointerdown", (e) => e.preventDefault());
  bar.addEventListener("mousedown", (e) => e.preventDefault());
  bar.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const txt = activeTxt() ?? last;
    if (!act || !txt) return;
    const row = txt.closest<HTMLElement>(".row");
    switch (act) {
      case "indent":
        return key(txt, "Tab");
      case "outdent":
        return key(txt, "Tab", { shiftKey: true });
      case "kind":
        // The "add a note" row has no kind yet; it gets one when text is typed.
        if (!row?.classList.contains("new")) key(txt, "Enter", { ctrlKey: true });
        return;
      case "archive":
        return row?.querySelector<HTMLElement>(".del")?.click();
      case "picture":
        return $<HTMLInputElement>("#pick-image").click();
      case "done":
        return txt.blur();
    }
  });

  // A picked picture goes through the outline's own paste path.
  $<HTMLInputElement>("#pick-image").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const txt = activeTxt() ?? last;
    if (!file || !txt) return;
    txt.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    txt.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

function wireMenu() {
  const menu = $("#menu");
  $("#btn-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#menu-account").textContent = store.account() || "Signed in";
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest("#menu")) menu.hidden = true;
  });
  $("#menu-sync").addEventListener("click", () => {
    menu.hidden = true;
    void store.syncNow();
  });
  $("#menu-signout").addEventListener("click", () => {
    if (store.hasPending() && !confirm("Some changes haven't synced yet and will be lost. Sign out anyway?")) return;
    void signOut();
  });
  $("#banner-action").addEventListener("click", () => void store.syncNow({ allowMassDelete: true }));
  $("#btn-clear-done").addEventListener("click", () => void clearCompleted());
}

async function showApp() {
  $("#boot").hidden = true;
  $("#signin").hidden = true;
  $("#app").hidden = false;
  wireToolbar();
  wireMenu();
  store.onStatus(renderStatus);
  store.onItemsChanged(() => void loadItems());
  store.onSignedOut(() => void store.wipe().then(() => location.reload()));
  renderStatus();
  await initImages();
  await loadItems();
  store.startSyncLoop();
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((err) => console.error("service worker failed", err));
  wireSignIn();
  const cached = await store.loadCache();
  try {
    await store.adopt(await store.whoami());
  } catch (err) {
    if (err instanceof store.SignedOut) {
      if (cached) await store.wipe();
      return showSignIn();
    }
    // No network (or the server is down): open what we have, or say why we can't.
    if (!cached) return showSignIn("You're offline. Connect once to sign in.");
  }
  await showApp();
}

void boot();
