import { defineConfig } from "vite-plus";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // Backend unit tests run in node. The pure derivation (gallery-order,
  // mime) and the bare-agnostic pump are exercised here today; the
  // drive/swarm-backed paths are covered by the fake-drive harness
  // (see docs/design/fake-drive-test-harness-spec.md).
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
