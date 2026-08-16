import { defineConfig } from "vite-plus";
import UnoCSS from "unocss/vite";

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [UnoCSS()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
