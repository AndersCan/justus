import { html } from "lit-html";
import { atom } from "nanostores";
import { useStore } from "../use-store";
import { $density, writeDensity, type Density } from "../utils/gallery-density";
import { readTheme, writeTheme, type Theme } from "../utils/theme";

const $theme = atom<Theme>(readTheme());

const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "system", label: "Auto", hint: "Follows your device" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

/** Auto / Light / Dark choice. Persists via `writeTheme`. */
export function themeSetting() {
  return useStore(
    $theme,
    (theme) => html`<div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
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
            writeTheme(o.value);
            $theme.set(o.value);
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

/** Gallery grid density: Comfortable / Compact. Persists via `writeDensity`. */
export function densitySetting() {
  return useStore(
    $density,
    (density) => html`<div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Photo grid">
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
            writeDensity(o.value);
            $density.set(o.value);
          }}
        >
          ${o.label}
        </button>`,
      )}
    </div>`,
  );
}
