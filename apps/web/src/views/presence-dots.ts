import { html, nothing } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { SyncMember } from "@justus/core";
import { memberColor } from "../utils/palette";
import { gridMotion } from "./grid-motion";

function dotClass(fill: string | undefined): string {
  return fill === undefined ? "ui-presence-dot-none" : "ui-presence-dot";
}

/** The album's members as coloured dots, kept by member so a join or removal animates only that dot. */
export function presenceDots(members: readonly SyncMember[], albumId: string) {
  return html`<span
    class="ui-presence-dots"
    aria-hidden="true"
    data-presence-dots
    ${gridMotion({ keys: members.map((m) => m.key), settle: albumId })}
  >
    ${repeat(
      members,
      (m) => m.key,
      (m) => {
        const fill = memberColor(m.color);
        return html`<span class="inline-flex" data-motion-key=${m.key}
          ><span
            class=${dotClass(fill)}
            style=${fill === undefined ? nothing : `background:${fill};`}
            title="${m.name}"
          ></span
        ></span>`;
      },
    )}
  </span>`;
}
