import { defineConfig } from "vite";
import { resolve } from "node:path";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        capture: resolve(process.cwd(), "capture.html"),
        tab: resolve(process.cwd(), "tab.html"),
        alert: resolve(process.cwd(), "alert.html"),
        journal: resolve(process.cwd(), "journal.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
