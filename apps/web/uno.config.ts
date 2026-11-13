import { defineConfig, presetUno } from "unocss";
import { buttonClass } from "#design/components/button.ts";
import { inputClass } from "#design/components/input.ts";
import { designTheme } from "#design/justus/tokens/uno.theme.ts";

// Semantic tokens only. Raw values live in src/design/justus/tokens/theme.css (generated) as CSS variables (space
// separated RGB) so light/dark switch with `prefers-color-scheme`. Views use
// bg-canvas / bg-surface / text-fg / text-muted / accent / danger — never a
// literal color. Green/amber/red `trust-*` is reserved for connection state.
// Status colors come in pairs: `danger` / `ok` / `warn` for fills and dots,
// `*-fg` for text (the fills are too light for text on white). Text on a solid
// accent or danger fill is `on-fill`. `brand` (coral) is the wordmark dot only. The one add/create action per screen
// is a `<wa-button variant="brand">` using the `--action` / `--on-action` tokens.
export default defineConfig({
  presets: [presetUno()],
  content: {
    pipeline: {
      // lit-html templates live in plain .ts files — UnoCSS's default
      // pipeline excludes .ts (it only scans vue/svelte/tsx/html), so the
      // classes would otherwise never be extracted.
      include: [/\.(vue|svelte|[jt]sx|ts|mdx?|astro|elm|php|phtml|marko|html)($|\?)/],
    },
  },
  theme: designTheme,
  shortcuts: {
    "ui-card": "rounded-2xl bg-surface ring-1 ring-line",
    "ui-focus":
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-0",
    "ui-btn":
      "ui-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition active:scale-[.98] disabled:pointer-events-none disabled:opacity-50",
    "ui-btn-primary": buttonClass({ variant: "primary" }),
    "ui-btn-ghost": buttonClass({ variant: "default" }),
    "ui-input": inputClass(),
    "ui-label": "text-xs font-semibold uppercase tracking-wider text-muted",
    "ui-chip":
      "inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs text-fg",
  },
});
