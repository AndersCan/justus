import { defineConfig } from "vite-plus";
import UnoCSS from "unocss/vite";

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [UnoCSS()],
  server: {
    // The dev worklet admits exactly this page origin (`origin=` in
    // apps/backend/scripts/dev.mjs), so the port must not drift.
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin for the worklet's `POST /photos` upload route in dev
      // (the loopback server answers at :8080; media GETs are absolute URLs
      // and bypass this proxy).
      "/photos": {
        target: "http://127.0.0.1:8080",
        // The worklet refuses a `Host` other than its own bound address.
        changeOrigin: true,
      },
      // Forward the web-layer log collector POST to the worklet's loopback
      // server so browser dev reaches `POST /__logs` same-origin (issue #14).
      "/__logs": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // Unit tests run in node — the machines' glue (actor-utils) is pure and must
  // not pull the Bare-backed `gateway`, so keep the suite off the DOM.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
