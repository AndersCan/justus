import { defineConfig } from "vite-plus";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // Backend unit tests run in node.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Inlined so the per-file vi.mock stubs for bare-* apply to the worklet runtime.
    server: { deps: { inline: ["@ekrooh/bare"] } },
  },
});
