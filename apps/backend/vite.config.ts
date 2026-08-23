import { defineConfig } from "vite-plus";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // Backend unit tests run in node. The pure derivation (gallery-order,
  // mime) and the bare-agnostic pump are exercised here today; the drive/swarm
  // substitutes for the fake-drive harness live in test/ (see
  // docs/design/fake-drive-test-harness-spec.md) and are exercised by
  // test/fake-drive.test.ts without needing a Bare runtime.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
