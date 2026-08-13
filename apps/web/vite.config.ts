import { defineConfig, lazyPlugins } from "vite-plus";
import UnoCSS from "unocss/vite";

export default defineConfig({
  root: ".",
  base: "./",
  plugins: lazyPlugins(() => [UnoCSS()]),
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
