// The web app's copy of the outline and its sync with the server. The outline
// code (`src/outline.ts`, shared with the desktop) talks to this through the
// `invoke` shim; this keeps the rows in memory, mirrors them to IndexedDB so
// the app opens offline, and runs the same push/pull cycle as the desktop's
// `sync.rs`, using the pure functions in `core.ts`.

import type { ArchivedItem, Item } from "../../src/outline";
import type { SyncResponse, WireRow } from "../../shared/protocol";
import { applyRows, emptyState, localRows, mergeFrontend, normalize, PAGE, planRows, repairRanks, type SyncState } from "./core";

export class SignedOut extends Error {}

interface Saved {
  items: Item[];
  archive: ArchivedItem[];
  state: SyncState;
}

export type SyncPhase = "idle" | "syncing" | "offline" | "error" | "paused";

export interface Status {
  phase: SyncPhase;
  message: string;
  /** Rows that would be deleted remotely, when a cycle stopped to ask first. */
  massDelete: number;
}

let items: Item[] = [];
let archive: ArchivedItem[] = [];
let seen: Item[] = [];
let state: SyncState = emptyState();
let status: Status = { phase: "idle", message: "", massDelete: 0 };
let allowMassDelete = false;

const listeners = { items: new Set<() => void>(), status: new Set<() => void>(), signedOut: new Set<() => void>() };
export const onItemsChanged = (fn: () => void) => listeners.items.add(fn);
export const onStatus = (fn: () => void) => listeners.status.add(fn);
export const onSignedOut = (fn: () => void) => listeners.signedOut.add(fn);
export const getStatus = () => status;
export const account = () => state.account;

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next };
  listeners.status.forEach((fn) => fn());
}

// ---------- IndexedDB (one record) ----------

const DB_NAME = "deskpad";
const STORE = "kv";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let persistTimer = 0;
function persist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const saved: Saved = { items, archive, state };
    idbSet("data", saved).catch((err) => console.error("could not save offline copy", err));
  }, 200);
}

/** Load the offline copy. Returns whether there was one. */
export async function loadCache(): Promise<boolean> {
  try {
    const saved = await idbGet<Saved>("data");
    if (!saved) return false;
    items = normalize(saved.items ?? []);
    archive = saved.archive ?? [];
    state = { ...emptyState(), ...saved.state };
    return !!state.device;
  } catch (err) {
    console.error("could not read offline copy", err);
    return false;
  }
}

/** Forget everything kept in this browser (on sign-out, or when the account changed). */
export async function wipe() {
  items = [];
  archive = [];
  seen = [];
  state = emptyState();
  window.clearTimeout(persistTimer);
  await idbSet("data", undefined).catch(() => {});
  // Pictures the service worker kept for offline use belong to the account too.
  if ("caches" in window) await caches.delete("deskpad-pics-v1").catch(() => false);
}

// ---------- what the outline calls (through the invoke shim) ----------

export function listForFrontend(): Item[] {
  seen = items.map((i) => ({ ...i }));
  return items.map((i) => ({ ...i }));
}

export function setFromFrontend(incoming: Item[]) {
  items = mergeFrontend(items, seen, incoming);
  seen = incoming.map((i) => ({ ...i }));
  repairRanks(items);
  touched();
}

/** Move rows and everything nested under them to the archive. */
export function archiveItems(ids: number[]) {
  const gone = new Set(ids);
  for (const i of items) if (i.parent !== null && gone.has(i.parent)) gone.add(i.id);
  const now = Math.floor(Date.now() / 1000);
  archive.push(...items.filter((i) => gone.has(i.id)).map((i) => ({ ...i, archived_at: now })));
  items = items.filter((i) => !gone.has(i.id));
  touched();
}

function touched() {
  persist();
  schedulePush();
}

// ---------- network ----------

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/v1${path}`, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new SignedOut();
  return res;
}

/** Who this browser is signed in as. Throws `SignedOut`, or a network error when offline. */
export async function whoami(): Promise<{ device: string; account: string }> {
  const res = await api("/status");
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const s = (await res.json()) as { device: string; account: string | null };
  return { device: s.device, account: s.account ?? "" };
}

/** Adopt the session's identity; a different account than the cached one starts clean. */
export async function adopt(me: { device: string; account: string }) {
  if (state.account && state.account !== me.account) await wipe();
  if (state.device !== me.device) {
    // A new session is a new device to the server: agree on everything afresh.
    state = { ...emptyState(), device: me.device, account: me.account };
  }
  state.account = me.account;
  persist();
}

async function postSync(since: number, rows: WireRow[]): Promise<SyncResponse> {
  const res = await api("/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since, rows, days: [] }) });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return (await res.json()) as SyncResponse;
}

let running: Promise<void> | null = null;
let again = false;

/** Push what changed and pull what's new. Calls made while one runs are folded into a follow-up. */
export function syncNow(opts: { allowMassDelete?: boolean } = {}): Promise<void> {
  if (opts.allowMassDelete) allowMassDelete = true;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await cycle();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function cycle() {
  if (!state.device) return;
  if (!navigator.onLine) return setStatus({ phase: "offline", message: "Offline. Changes are kept here and sync later." });
  setStatus({ phase: "syncing", message: "" });
  const allow = allowMassDelete;
  allowMassDelete = false;
  let pullOnly = state.since === 0 && Object.keys(state.base).length === 0;
  let changedAny = false;
  try {
    for (let i = 0; i < 200; i++) {
      let rows: WireRow[] = [];
      if (!pullOnly) {
        const plan = planRows(state, localRows(items, archive), Date.now());
        if (plan.deletes > 20 && plan.deletes * 2 > Object.keys(state.base).length && !allow) {
          persist();
          return setStatus({ phase: "paused", massDelete: plan.deletes, message: `Sync is paused: ${plan.deletes} synced rows are no longer on this device. Nothing was deleted in the cloud.` });
        }
        rows = plan.rows;
      }
      persist();
      const resp = await postSync(state.since, rows);
      const applied = applyRows(state, items, archive, rows, resp.rows ?? []);
      state.since = Math.max(state.since, resp.seq);
      if (applied.changed) {
        items = applied.items;
        archive = applied.archive;
        repairRanks(items);
        changedAny = true;
      }
      persist();
      if (resp.more) continue;
      if (pullOnly) {
        pullOnly = false;
        continue;
      }
      if (rows.length < PAGE) break;
    }
    setStatus({ phase: "idle", message: "", massDelete: 0 });
  } catch (err) {
    if (err instanceof SignedOut) {
      listeners.signedOut.forEach((fn) => fn());
      return;
    }
    // fetch rejects with a TypeError when the network is unreachable.
    if (err instanceof TypeError) setStatus({ phase: "offline", message: "Offline. Changes are kept here and sync later." });
    else setStatus({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (changedAny) listeners.items.forEach((fn) => fn());
  }
}

let pushTimer = 0;
function schedulePush() {
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void syncNow(), 1500);
}

/** Keep in step while the app is open: on a timer, when it comes back to the front, when the network returns. */
export function startSyncLoop() {
  void syncNow();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void syncNow();
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => setStatus({ phase: "offline", message: "Offline. Changes are kept here and sync later." }));
}

/** True while there are changes the server hasn't acknowledged. */
export const hasPending = () => Object.keys(state.pending).length > 0;

// ---------- pictures ----------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upload a pasted or picked picture; returns its content-addressed name. */
export async function saveImage(bytes: Uint8Array, ext: string): Promise<string> {
  const clean = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const name = `${(await sha256Hex(bytes)).slice(0, 20)}.${clean}`;
  let res: Response;
  try {
    res = await api(`/images/${name}`, { method: "PUT", body: bytes as BodyInit });
  } catch (err) {
    if (err instanceof SignedOut) throw err;
    throw new Error("Pictures need a connection. Try again when you're online.");
  }
  if (res.status === 413) throw new Error("That picture is too large (10 MB at most).");
  if (res.status === 415) throw new Error("That kind of picture isn't supported.");
  if (!res.ok) throw new Error(`The picture could not be saved (${res.status}).`);
  return name;
}
