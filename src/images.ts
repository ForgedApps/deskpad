// Pasted images. The bytes go to the backend (`save_image`), which stores them
// once under the data folder's `images\` and returns a file name; the row text
// then holds `![](img:<name>)`, which `renderInline` turns into an <img> served
// through Tauri's asset protocol. One file per image: the sidebar scales it to
// its own width with CSS, so no thumbnails are made.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { setImageResolver } from "./text";

let dir: string | null = null;

/** Point `renderInline` at the images folder. Call once per window at startup. */
export async function initImages(): Promise<void> {
  try {
    dir = await invoke<string>("image_dir");
  } catch (err) {
    console.error("image_dir failed", err);
    return;
  }
  const base = dir;
  setImageResolver((name) => convertFileSrc(`${base}` + "\\" + name));
}

/** The first image on the clipboard, if any. */
export function clipboardImage(dt: DataTransfer): File | null {
  for (const f of Array.from(dt.files)) if (f.type.startsWith("image/")) return f;
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

/** Store the image and return the marker to put in a row's text. */
export async function saveImage(file: File): Promise<string> {
  const ext = (file.type.split("/")[1] ?? "png").replace(/^jpeg$/, "jpg").replace(/^svg\+xml$/, "svg").replace(/[^a-z0-9]/gi, "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = await invoke<string>("save_image", bytes, { headers: { "x-ext": ext || "png" } });
  return `![](img:${name})`;
}
