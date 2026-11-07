import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import { prefs, prefsActor } from "../machines/prefs-machine";
import type { Density } from "../utils/gallery-density";
import type { Theme } from "../utils/theme";

const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "system", label: "Auto", hint: "Follows your device" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

/** Auto / Light / Dark choice. Persists via `prefs.setTheme`. */
export function themeSetting() {
  return watch(
    prefsActor,
    ({ context: { theme } }) => html`<div
      class="grid grid-cols-3 gap-2"
      role="radiogroup"
      aria-label="Theme"
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
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/** Gallery grid density: Comfortable / Compact. Persists via `prefs.setDensity`. */
export function densitySetting() {
  return watch(
    prefsActor,
    ({ context: { density } }) => html`<div
      class="grid grid-cols-2 gap-2"
      role="radiogroup"
      aria-label="Photo grid"
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
