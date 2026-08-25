import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  // `e2e/` holds Playwright specs (run via `pnpm test:e2e` / `playwright test`),
  // not vitest specs. Vitest's default exclude only covers node_modules/.git,
  // so a bare `vp test run` otherwise globs e2e/*.spec.ts and loads
  // @playwright/test through its own module runner — Playwright then errors
  // ("two versions of @playwright/test" / "test() in async describe"). Keep the
  // root project out of vitest discovery so the e2e suite stays Playwright-only.
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/e2e/**"],
  },
});
