// Wire types for Deskpad sync (`/api/v1`). Imported by the Worker (`cloud/`)
// and, later, by the mobile web app; `src-tauri/src/sync.rs` mirrors them with
// serde. Keep the three in step.

/** One outline row as it travels. Ids are strings on the wire (the desktop's
 *  numeric ids are sent as decimal strings). */
export interface WireRow {
  id: string;
  text: string;
  kind: "note" | "task";
  done: boolean;
  parent: string | null;
  /** Order among siblings: plain string comparison, see `rank` in sync.rs. */
  rank: string;
  /** Unix seconds. */
  created_at: number;
  done_at: number | null;
  schedule: { start: number; end: number; all_day: boolean; event_id: string | null } | null;
  /** Unix seconds; null while the row is in the outline. */
  archived_at: number | null;
  /** Hybrid logical clock, milliseconds. The larger value wins a conflict. */
  updated_at: number;
  /** Device that made the change; breaks `updated_at` ties. */
  updated_by: string;
  deleted: boolean;
  /** Server change number. Absent on rows a client sends. */
  seq?: number;
}

/** One day's calendar events as a device last saw them. */
export interface WireDay {
  day: string; // YYYY-MM-DD
  events: unknown[];
  updated_at: number;
  updated_by: string;
  seq?: number;
}

export interface SyncRequest {
  /** Highest `seq` this device has applied; 0 on a first sync. */
  since: number;
  rows: WireRow[];
  days: WireDay[];
}

export interface SyncResponse {
  /** Pass back as `since` next time. */
  seq: number;
  /** Everything with `seq > since`, plus the server's copy of any row or day
   *  it refused because its own was newer. */
  rows: WireRow[];
  days: WireDay[];
  /** True when the page limit cut the result; call again with the new `seq`. */
  more: boolean;
}

export interface ExportResponse {
  tenant: string;
  seq: number;
  exported_at: number;
  rows: WireRow[];
  days: WireDay[];
}

/** Largest batch in either direction. */
export const PAGE = 2000;

/** Stored image names: 20 hex chars of the content's SHA-256, plus extension. */
export const IMAGE_NAME = /^[0-9a-f]{20}\.[a-z0-9]{1,5}$/;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** True when `a` should replace `b`. */
export function newer(a: { updated_at: number; updated_by: string }, b: { updated_at: number; updated_by: string }): boolean {
  return a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.updated_by > b.updated_by);
}
