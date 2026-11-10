// Stands in for `@tauri-apps/api/core` in the web build (see the aliases in
// vite.web.config.ts), so the outline code shared with the desktop runs
// unchanged: its backend commands are answered by `store.ts` instead of Rust.

import type { Item } from "../../../src/outline";
import * as store from "../store";

type Args = Record<string, unknown> | Uint8Array | ArrayBuffer | undefined;

export async function invoke<T>(cmd: string, args?: Args, options?: { headers?: Record<string, string> }): Promise<T> {
  switch (cmd) {
    case "list_items":
      return store.listForFrontend() as T;
    case "set_items":
      store.setFromFrontend((args as { items: Item[] }).items);
      return undefined as T;
    case "archive_items":
      store.archiveItems((args as { ids: number[] }).ids);
      return undefined as T;
    case "image_dir":
      return "/api/v1/images" as T;
    case "save_image": {
      const bytes = args instanceof Uint8Array ? args : new Uint8Array(args as ArrayBuffer);
      return (await store.saveImage(bytes, options?.headers?.["x-ext"] ?? "png")) as T;
    }
    case "schedule_item":
    case "unschedule_item":
      // The time stays on the row and syncs; only the desktop talks to Google Calendar.
      throw "Calendar events are added by the Deskpad desktop app.";
    case "log_js":
      return undefined as T;
    default:
      throw `Not available in the web app: ${cmd}`;
  }
}

/** `images.ts` joins the folder and the file name with a backslash; only the name matters here. */
export function convertFileSrc(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return `/api/v1/images/${encodeURIComponent(name)}`;
}
