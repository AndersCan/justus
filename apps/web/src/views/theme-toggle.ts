import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import { prefs, prefsActor } from "../machines/prefs-machine";
import type { Density } from "../utils/gallery-density";
import type { Theme } from "../utils/theme";

import { copy } from "../copy/copy";
const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  {
    value: "system",
    label: copy("theme_toggle.auto"),
    hint: copy("theme_toggle.follows_your_device"),
  },
  { value: "light", label: copy("theme_toggle.light"), hint: copy("theme_toggle.always_light") },
  { value: "dark", label: copy("theme_toggle.dark"), hint: copy("theme_toggle.always_dark") },
];

/** Auto / Light / Dark choice. Persists via `prefs.setTheme`. */
export function themeSetting() {
  return watch(
    prefsActor,
    ({ context: { theme } }) => html`<div
      class="grid grid-cols-3 gap-2"
      role="radiogroup"
      aria-label=${copy("theme_toggle.theme")}
    >
      ${OPTIONS.map(
        (o) => html`<button
          type="button"
          role="radio"
          aria-checked=${o.value === theme ? "true" : "false"}
          title=${o.hint}
          class="ui-focus rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition ${
            o.value === theme
              ? "bg-accent/10 text-accent ring-accent"
              : "bg-subtle text-fg ring-line hover:bg-line"
          }"
          @click=${() => {
            prefs.setTheme(o.value);
          }}
        >
          ${o.label}
        </button>`,
      )}
    </div>`,
  );
}

const DENSITIES: { value: Density; label: string }[] = [
  { value: "comfortable", label: copy("theme_toggle.comfortable") },
  { value: "compact", label: copy("theme_toggle.compact") },
];

/** Gallery grid density: Comfortable / Compact. Persists via `prefs.setDensity`. */
export function densitySetting() {
  return watch(
    prefsActor,
    ({ context: { density } }) => html`<div
      class="grid grid-cols-2 gap-2"
      role="radiogroup"
      aria-label=${copy("theme_toggle.photo_grid")}
    >
      ${DENSITIES.map(
        (o) => html`<button
          type="button"
          role="radio"
          aria-checked=${o.value === density ? "true" : "false"}
          class="ui-focus rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition ${
            o.value === density
              ? "bg-accent/10 text-accent ring-accent"
              : "bg-subtle text-fg ring-line hover:bg-line"
          }"
          @click=${() => {
            prefs.setDensity(o.value);
          }}
        >
          ${o.label}
        </button>`,
      )}
    </div>`,
  );
}
