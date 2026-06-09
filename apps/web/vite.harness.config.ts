import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Standalone build of the offscreen thumbnail render harness
 * (`src/thumbHarness.ts` + `thumb-harness.html`). `vite-plugin-singlefile`
 * inlines all JS/CSS into ONE self-contained HTML so apps/fixture-sync can load
 * it via Playwright's `setContent()` with no static server or external chunks.
 *
 * Output goes to `dist-harness/` (NOT the SPA's `dist/`), so the harness never
 * ships to production. Build with `pnpm --filter @wac/web build:harness`.
 */
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist-harness",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: "thumb-harness.html" },
  },
});
