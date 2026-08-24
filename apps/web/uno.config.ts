import { defineConfig, presetUno } from "unocss";

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
      paper: "#FAF3E7",
      linen: "#FFFDF6",
      butter: "#F3E4CC",
      line: "#E8D6BA",
      "line-strong": "#E2CEB2",
      ink: "#3A2A1D",
      cocoa: "#5A4533",
      taupe: "#8A7159",
      clay: "#B05C2E",
      "clay-deep": "#9A4E24",
      caramel: "#C99A5B",
      moss: "#6E7F45",
      plum: "#7C5A88",
      honey: "#C98A2D",
      brick: "#B3452F",
      // Trust color language — reserved for connection state only (vision:
      // "green/amber/red reserved for connection"). The header's p2p indicator
      // is the sole consumer.
      trust: {
        green: "#2E8B57",
        amber: "#C98A2D",
        red: "#B3452F",
      },
    },
    fontFamily: {
      serif: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif',
    },
  },
  shortcuts: {
    "warm-card":
      "rounded-2xl bg-linen ring-1 ring-line shadow-[0_1px_2px_rgba(100,60,20,.06),0_6px_16px_rgba(100,60,20,.10)]",
    "warm-pill":
      "rounded-full bg-clay px-5 py-2.5 min-h-11 text-sm font-semibold text-linen shadow-[0_4px_12px_rgba(176,92,46,.35)] hover:bg-clay-deep active:translate-y-px disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/30",
    "warm-ghost":
      "rounded-full border border-line bg-white/70 min-h-11 px-4 py-2.5 text-cocoa hover:bg-butter active:translate-y-px disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/30",
    "warm-input":
      "rounded-xl border border-line-strong bg-white/80 px-3.5 py-2.5 text-ink placeholder:text-taupe outline-none focus:border-clay focus:ring-2 focus:ring-clay/25",
    "warm-label": "text-xs font-bold uppercase tracking-widest text-taupe",
  },
});
