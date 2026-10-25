import { html } from "lit-html";
import { atom } from "nanostores";
import { useStore } from "../use-store";
import { nextTheme, readTheme, writeTheme, type Theme } from "../utils/theme";

const $theme = atom<Theme>(readTheme());

const LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

const ICON: Record<Theme, string> = {
  system: "M4 5h16v11H4zM9 20h6M12 16v4",
  light:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  dark: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
};

/** Cycles system → light → dark. Persists via `writeTheme`. */
export function themeToggle() {
  return useStore(
    $theme,
    (theme) => html`<button
      class="ui-btn-ghost !min-h-9 !gap-1.5 !px-2.5 !py-1.5 text-xs"
      title="Theme: ${LABEL[theme]} (click to change)"
      aria-label="Theme: ${LABEL[theme]}. Change theme"
      @click=${() => {
        const next = nextTheme(theme);
        writeTheme(next);
        $theme.set(next);
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d=${ICON[theme]} />
      </svg>
      ${LABEL[theme]}
    </button>`,
  );
}
