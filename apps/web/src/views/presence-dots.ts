import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { SyncMember } from "@justus/core";
import { memberColor } from "../utils/palette";
import { styleMap } from "lit-html/directives/style-map.js";
import { gridMotion } from "./grid-motion";

const dotFill = (fill: string | undefined) => (fill === undefined ? {} : { background: fill });

function dotClass(fill: string | undefined): string {
  return fill === undefined
    ? "inline-block h-3 w-3 rounded-full border border-muted bg-surface ring-2 ring-white"
    : "inline-block h-3 w-3 rounded-full ring-2 ring-white";
}

/** The album's members as coloured dots, kept by member so a join or removal animates only that dot. */
export function presenceDots(members: readonly SyncMember[], albumId: string) {
  return html`<span
    class="flex items-center gap-1.5"
    aria-hidden="true"
    data-presence-dots
    ${gridMotion({ keys: members.map((m) => m.key), settle: albumId })}
  >
    ${repeat(
      members,
      (m) => m.key,
      (m) =>
        html`<span class="inline-flex" data-motion-key=${m.key}
          ><span
            class=${dotClass(memberColor(m.color))}
            style=${styleMap(dotFill(memberColor(m.color)))}
            title="${m.name}"
          ></span
        ></span>`,
    )}
  </span>`;
}
