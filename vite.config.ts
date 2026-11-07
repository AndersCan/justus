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
    // The backend runs in Bare, which lacks these Web globals (#200: a
    // `new TextDecoder()` made every peer record read as missing on devices).
    overrides: [
      {
        files: ["apps/backend/src/**/*.ts"],
        rules: {
          "no-restricted-globals": [
            "error",
            { name: "TextDecoder", message: "Bare has no TextDecoder: use Buffer.toString." },
            { name: "TextEncoder", message: "Bare has no TextEncoder: use Buffer.from." },
            { name: "atob", message: "Bare has no atob: use base64ToBytes." },
            { name: "btoa", message: "Bare has no btoa." },
          ],
        },
      },
      // The p2p and file libraries are reached only through ports (src/ports); only adapters and the composition root main.core.ts import them (docs/adr/0002 decision 5).
      {
        files: ["apps/backend/src/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex:
                    "^(hyperswarm|hyperdrive|hypercore|corestore|protomux|hyperdht|bare-fs|bare-path)(/|$)",
                  message:
                    "Import p2p and file libraries only in src/adapters (or main.core.ts); use a port from src/ports.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/backend/src/adapters/**/*.ts", "apps/backend/src/main.core.ts"],
        rules: { "no-restricted-imports": "off" },
      },
    ],
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
    exclude: ["**/node_modules/**", "**/.git/**", "**/e2e/**", "**/.claude/**"],
  },
});
