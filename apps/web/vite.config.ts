import { defineConfig } from "vite-plus";
import UnoCSS from "unocss/vite";

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [UnoCSS()],
  server: {
    proxy: {
      // Same-origin for the worklet's `POST /photos` upload route in dev
      // (the loopback server answers at :8080; media GETs are absolute URLs
      // and bypass this proxy).
      "/photos": {
        target: "http://127.0.0.1:8080",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
