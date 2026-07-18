import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Builds the standalone Thom widget into ../public so the Worker's `assets`
 * binding serves it. `widget.html` → public/widget.html (served at /widget via
 * html_handling auto). Hand-authored static (embed.js, the landing index.html)
 * lives in ./public and is copied verbatim by Vite's publicDir step.
 *
 * emptyOutDir is on: every build produces a clean ../public, and because the
 * hand-authored files are sourced from THIS package's ./public they are copied
 * back in on each build (so nothing hand-authored is lost + no stale hashes).
 */
export default defineConfig({
  root: dir,
  base: "/",
  server: {
    port: 5174,
    // Standalone widget dev (`pnpm --filter @wac/thom-bot dev:widget`) proxies
    // /api/* to a locally running Worker (`pnpm --filter @wac/thom-bot dev`,
    // wrangler dev on :8787).
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../public", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./widget.html", import.meta.url)),
    },
  },
});
