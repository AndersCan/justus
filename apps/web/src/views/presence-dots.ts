import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import type { SyncMember } from "@justus/core";
import { memberColor } from "../utils/palette";
import { gridMotion } from "./grid-motion";

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
            class="inline-block h-3 w-3 rounded-full ring-2 ring-white"
            style="background: ${memberColor(m.key)}"
            title="${m.name}"
          ></span
        ></span>`,
    )}
  </span>`;
}
