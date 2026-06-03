import { defineConfig } from "vitest/config";

export default defineConfig({
  // `sharp` is a native addon — let Node require it directly instead of letting
  // Vite try to transform/bundle it (which fails to resolve the .node binary).
  ssr: { external: ["sharp"] },
  test: {
    include: ["src/**/*.test.ts"],
    server: { deps: { external: ["sharp"] } },
  },
});
