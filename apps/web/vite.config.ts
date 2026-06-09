import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind all interfaces (IPv4 + IPv6). Without this Vite binds only to
    // `localhost`, which on some machines resolves to IPv6 `::1` ONLY — so
    // browsers that resolve `localhost` to IPv4 `127.0.0.1` (Safari) can't reach
    // the server and fall back to a stale cached page, while Chrome (IPv6) sees
    // fresh code. Listening on 0.0.0.0 makes 127.0.0.1 reachable too.
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
  },
});
