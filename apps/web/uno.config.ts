import { defineConfig, presetUno } from "unocss";

/**
 * Justus design tokens — a cosy, dusk-lit palette built from the project's
 * five anchor colors: lavender mist surfaces, coffee-bean ink, lavender-purple
 * primary, light-coral for emphasis, royal-gold for warm highlights. Serif
 * display type and soft shadows keep the homey feel.
 */
export default defineConfig({
  presets: [presetUno()],
  // The default pipeline only scans .vue/.tsx/.html — this app's templates
  // live in plain .ts modules, so without including them NOTHING gets
  // generated (the old app shipped zero CSS for exactly this reason).
  content: {
    pipeline: {
      include: [
        /\.(vue|svelte|[jt]sx|vine\.ts|mdx?|astro|elm|php|phtml|marko|html)($|\?)/,
        /\.(ts|js)($|\?)/,
      ],
    },
  },
  theme: {
    colors: {
      // Coffee-bean ink — the deep warm-brown-black used for text and shadows.
      ink: {
        50: "#FAF5F7",
        100: "#F3E9EC",
        200: "#E5D2D8",
        300: "#C9A9B3",
        400: "#A27A88",
        500: "#7C5161",
        600: "#5C3546",
        700: "#452333",
        800: "#331522",
        900: "#280D1A",
        950: "#1F0812",
      },
      // Lavender mist — the calm paper background.
      mist: {
        50: "#F7F8FD",
        100: "#E9EBF8",
        200: "#D8DCEE",
        300: "#BCC3E0",
        400: "#9BA4CC",
        500: "#7C86B4",
        600: "#5F6A9C",
        700: "#4A5480",
        800: "#363D61",
        900: "#262B45",
      },
      // Lavender-purple — primary actions.
      lavpur: {
        50: "#F4EEFB",
        100: "#E8DCF7",
        200: "#D0BCEE",
        300: "#B496E2",
        400: "#A07DD4",
        500: "#9067C6",
        600: "#7A4FB4",
        700: "#643F97",
        800: "#4E3276",
        900: "#3A2759",
      },
      // Light coral — destructive/emphasis.
      coral: {
        50: "#FDEEEE",
        100: "#FBDDDB",
        200: "#F7C2BF",
        300: "#F3A29E",
        400: "#F08A87",
        500: "#EF6F6C",
        600: "#D94F4C",
        700: "#B53E3B",
        800: "#8F312F",
        900: "#6B2625",
      },
      // Royal gold — warm highlights, focus.
      gold: {
        50: "#FEFBEA",
        100: "#FDF5CC",
        200: "#FBEBA0",
        300: "#F9E276",
        400: "#F8E16C",
        500: "#E8C54A",
        600: "#C9A232",
        700: "#A07E26",
        800: "#7C601F",
        900: "#5C4719",
      },
    },
    fontFamily: {
      display:
        'Georgia, ui-serif, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
      body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    },
    boxShadow: {
      soft: "0 1px 2px rgba(31, 8, 18, 0.06), 0 10px 24px -14px rgba(31, 8, 18, 0.25)",
      "soft-lg": "0 2px 4px rgba(31, 8, 18, 0.08), 0 18px 40px -16px rgba(31, 8, 18, 0.32)",
      "soft-inner": "inset 0 1px 0 rgba(255, 255, 255, 0.65)",
    },
  },
  shortcuts: {
    // Buttons
    btn: "inline-flex cursor-pointer select-none items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400 disabled:pointer-events-none disabled:opacity-50",
    "btn-primary":
      "btn bg-lavpur-600 text-white shadow-soft hover:bg-lavpur-700 active:bg-lavpur-800",
    "btn-ghost":
      "btn border border-mist-300 bg-white/70 text-ink-800 shadow-soft hover:bg-mist-100 hover:border-mist-400 active:bg-mist-200",
    "btn-danger": "btn bg-coral-600 text-white shadow-soft hover:bg-coral-700 active:bg-coral-800",
    "btn-link": "btn px-0 py-0 text-lavpur-700 hover:text-lavpur-800 hover:underline",
    // Surfaces
    card: "rounded-2xl border border-mist-200 bg-white/80 shadow-soft backdrop-blur-sm",
    // Form fields
    input:
      "w-full rounded-lg border border-mist-300 bg-mist-50 px-3 py-2 text-sm text-ink-900 shadow-soft-inner outline-none transition-colors placeholder:text-ink-400 focus:border-lavpur-400 focus:ring-2 focus:ring-lavpur-200",
    // Small pills / chips
    chip: "inline-flex items-center gap-1 rounded-full border border-mist-200 bg-mist-100 px-2.5 py-0.5 text-xs font-medium text-ink-700",
    // Section / field labels
    label: "text-xs font-semibold uppercase tracking-wider text-ink-500",
  },
  rules: [
    // Soft paper grain — low-opacity coral/gold/purple radials over the base.
    [
      /^bg-paper$/,
      () => ({
        "background-image":
          "radial-gradient(circle at 18% 8%, rgba(239, 111, 108, 0.05), transparent 42%), radial-gradient(circle at 85% 28%, rgba(248, 225, 108, 0.06), transparent 40%), radial-gradient(circle at 45% 92%, rgba(144, 103, 198, 0.06), transparent 45%)",
      }),
    ],
  ],
});
