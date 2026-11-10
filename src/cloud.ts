// The "Cloud sync" section of the settings dialog. Sync itself lives in the
// backend (`sync.rs`); this signs the PC in or out and shows how sync is going.
// Signing in happens in the browser: the backend opens the approval page and
// waits, and this shows the code to compare meanwhile.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface CloudStatus {
  configured: boolean;
  url: string;
  device: string;
  account: string;
  signing_in: string | null;
  last_sync: number | null;
  error: string | null;
  rows: number;
  mass_delete: number | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Draw the section from the backend's current status. */
export async function renderCloud() {
  let s: CloudStatus;
  try {
    s = await invoke<CloudStatus>("cloud_status");
  } catch (err) {
    console.error("cloud_status failed", err);
    return;
  }
  const waiting = !!s.signing_in;
  $("#cloud-on").classList.toggle("hidden", !s.configured || waiting);
  $("#cloud-off").classList.toggle("hidden", s.configured || waiting);
  $("#cloud-wait").classList.toggle("hidden", !waiting);
  if (waiting) {
    $("#cloud-code").textContent = s.signing_in;
    return;
  }
  if (!s.configured) {
    // Signed out behind our back (session ended elsewhere or expired).
    if (s.error) $("#cloud-error").textContent = s.error;
    return;
  }
  const state = $("#cloud-state");
  state.classList.toggle("ok", !s.error);
  state.classList.toggle("error", !!s.error);
  const who = s.account ? `Signed in as ${s.account}` : "Signed in";
  if (s.error) {
    state.textContent = s.error;
  } else if (s.last_sync) {
    const at = new Date(s.last_sync * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    state.textContent = `● ${who} · synced at ${at}`;
  } else {
    state.textContent = `${who} · syncing…`;
  }
  const force = $<HTMLButtonElement>("#btn-cloud-force");
  force.classList.toggle("hidden", !s.mass_delete);
  if (s.mass_delete) force.textContent = `Delete those ${s.mass_delete} rows in the cloud too`;
}

export function wireCloud() {
  $("#btn-cloud-signin").addEventListener("click", async () => {
    const err = $("#cloud-error");
    err.textContent = "";
    try {
      // Resolves once the sign-in is approved in the browser (or fails).
      await invoke("cloud_sign_in");
    } catch (e) {
      err.textContent = String(e);
    }
    await renderCloud();
  });
  $("#btn-cloud-cancel").addEventListener("click", () => {
    invoke("cloud_cancel_sign_in").catch((e) => console.error("cloud_cancel_sign_in failed", e));
  });
  $("#btn-cloud-signout").addEventListener("click", async () => {
    await invoke("cloud_sign_out").catch((e) => console.error("cloud_sign_out failed", e));
    await renderCloud();
  });
  $("#btn-cloud-sync").addEventListener("click", () => {
    $("#cloud-state").textContent = "Syncing…";
    invoke("cloud_sync_now", {}).catch((e) => console.error("cloud_sync_now failed", e));
  });
  $("#btn-cloud-force").addEventListener("click", () => {
    $("#cloud-state").textContent = "Syncing…";
    invoke("cloud_sync_now", { allowMassDelete: true }).catch((e) => console.error("cloud_sync_now failed", e));
  });
  listen("cloud-status", () => renderCloud()).catch((err) => console.error("listen failed", err));
}
