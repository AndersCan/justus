import { defineConfig, presetUno } from "unocss";

// Semantic tokens only. Raw values live in index.html as CSS variables (space
// separated RGB) so light/dark switch with `prefers-color-scheme`. Views use
// bg-canvas / bg-surface / text-fg / text-muted / accent / danger — never a
// literal color. Green/amber/red `trust-*` is reserved for connection state.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

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
  theme: {
    colors: {
      canvas: token("canvas"),
      surface: token("surface"),
      subtle: token("subtle"),
      line: token("line"),
      fg: token("fg"),
      muted: token("muted"),
      accent: token("accent"),
      "accent-strong": token("accent-strong"),
      danger: token("danger"),
      ok: token("ok"),
      warn: token("warn"),
      trust: {
        green: token("trust-green"),
        amber: token("trust-amber"),
        red: token("trust-red"),
      },
    },
  },
  shortcuts: {
    "ui-card": "rounded-2xl bg-surface ring-1 ring-line",
    "ui-focus":
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-0",
    "ui-btn":
      "ui-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition active:scale-[.98] disabled:pointer-events-none disabled:opacity-50",
    "ui-btn-primary": "ui-btn bg-accent text-white hover:bg-accent-strong",
    "ui-btn-ghost": "ui-btn bg-subtle text-fg hover:bg-line",
    "ui-input":
      "min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25",
    "ui-label": "text-xs font-semibold uppercase tracking-wider text-muted",
    "ui-chip":
      "inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-xs text-fg",
  },
});
