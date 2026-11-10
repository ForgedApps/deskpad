// The "Cloud sync" section of the settings dialog. Sync itself lives in the
// backend (`sync.rs`); this only connects a PC (server address + device
// token), shows how it is going, and offers "sync now".

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface CloudStatus {
  configured: boolean;
  url: string;
  device: string;
  last_sync: number | null;
  error: string | null;
  rows: number;
  mass_delete: number | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Draw the section from the backend's current status. */
export async function renderCloud() {
  let s: CloudStatus;
  try {
    s = await invoke<CloudStatus>("cloud_status");
  } catch (err) {
    console.error("cloud_status failed", err);
    return;
  }
  $("#cloud-on").classList.toggle("hidden", !s.configured);
  $("#cloud-off").classList.toggle("hidden", s.configured);
  if (!s.configured) return;
  const state = $("#cloud-state");
  state.classList.toggle("ok", !s.error);
  state.classList.toggle("error", !!s.error);
  if (s.error) {
    state.textContent = s.error;
  } else if (s.last_sync) {
    const at = new Date(s.last_sync * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    state.textContent = `● Synced with ${host(s.url)} at ${at} · ${s.rows} rows`;
  } else {
    state.textContent = `Connecting to ${host(s.url)}…`;
  }
  const force = $<HTMLButtonElement>("#btn-cloud-force");
  force.classList.toggle("hidden", !s.mass_delete);
  if (s.mass_delete) force.textContent = `Delete those ${s.mass_delete} rows in the cloud too`;
}

export function wireCloud() {
  $("#btn-cloud-connect").addEventListener("click", async () => {
    const err = $("#cloud-error");
    err.textContent = "";
    try {
      await invoke("cloud_configure", { url: $<HTMLInputElement>("#s-cloud-url").value, token: $<HTMLInputElement>("#s-cloud-token").value });
      $<HTMLInputElement>("#s-cloud-token").value = "";
    } catch (e) {
      err.textContent = String(e);
      return;
    }
    await renderCloud();
  });
  $("#btn-cloud-disconnect").addEventListener("click", async () => {
    await invoke("cloud_configure", { url: "", token: "" }).catch((e) => console.error("cloud_configure failed", e));
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
