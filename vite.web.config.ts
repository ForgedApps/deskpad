// Builds the web app (web/) into cloud/public, which the Worker serves as
// static assets. The outline code is shared with the desktop: its Tauri
// imports are pointed at the shims in web/src/shim.
import { defineConfig } from "vite";
import { resolve } from "node:path";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const shim = (name: string) => resolve(process.cwd(), "web/src/shim", name);

export default defineConfig({
  root: "web",
  publicDir: "public",
  clearScreen: false,
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/plugin-opener": shim("opener.ts"),
    },
  },
  build: {
    outDir: "../cloud/public",
    emptyOutDir: true,
  },
  server: {
    port: 1430,
    strictPort: true,
    // `npm run dev` in cloud/ serves the API on 8787.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
