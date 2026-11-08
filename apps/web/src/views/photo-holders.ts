import { html } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { keyed } from "lit-html/directives/keyed.js";
import type { Photo } from "@justus/core";
import { lightboxActor, lightboxEvents } from "../machines/lightbox-machine";
import { holdersLine, holdersSheetRows } from "../utils/holders";
import { avatarBadge } from "./avatar";

/** The "who has this photo" row on photo detail, and the sheet it opens. */

const ROW_ATTR = "data-holders-row";

export function openHolders(): void {
  lightboxActor.send(lightboxEvents.holdersOpened.create());
}

/** Close the sheet and put focus back on the row that opened it. */
export function closeHolders(): void {
  lightboxActor.send(lightboxEvents.holdersClosed.create());
  queueMicrotask(() => document.querySelector<HTMLElement>(`[${ROW_ATTR}]`)?.focus());
}

/** A fixed-height row, so the photo above it never moves when the text changes. */
export function holdersRow(photo: Photo) {
  const { text, tappable } = holdersLine(photo.holders);
  const label = html`<span
    class="justus-holders-text min-w-0 flex-1 truncate text-left text-xs ${
      tappable ? "text-fg" : "text-muted"
    }"
    aria-live="polite"
    >${text}</span
  >`;
  const body = keyed(text, label);
  if (!tappable) {
    return html`<div class="mt-3 flex h-11 items-center gap-2 border-t border-line pt-1">
      ${body}
    </div>`;
  }
  return html`<button
    class="ui-focus -mx-2 mt-3 flex h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-lg border-t border-line px-2 pt-1 hover:bg-subtle"
    ${ROW_ATTR}
    aria-label="${text}, show who has this photo"
    @click=${openHolders}
  >
    ${body}<span class="text-muted" aria-hidden="true">›</span>
  </button>`;
}

function personRow(name: string, detail?: string) {
  return html`<li class="flex items-center gap-3 py-2">
    ${avatarBadge(name)}
    <div class="min-w-0">
      <div class="truncate text-sm text-fg">${name}</div>
      ${detail ? html`<div class="text-xs text-muted">${detail}</div>` : null}
    </div>
  </li>`;
}

export function holdersSheet(photo: Photo) {
  const rows = holdersSheetRows(photo.holders);
  return html`<div
    class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
    @click=${closeHolders}
  >
    <div
      class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Who has this photo"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <h3 class="text-base font-semibold text-fg">Who has this photo</h3>
      <p class="text-xs text-muted">Phones with a full copy, as they last told yours.</p>
      <div class="max-h-[60vh] overflow-y-auto">
        <ul>
          ${personRow("You", rows.youArriving ? "Arriving…" : undefined)}
          ${rows.others.map((m) => personRow(m.name))}
        </ul>
        ${
          rows.unsure.length > 0
            ? html`<h4 class="ui-label mt-4">Hasn't said yet</h4>
                <ul>
                  ${rows.unsure.map((m) => personRow(m.name))}
                </ul>
                <p class="text-xs text-muted">
                  A phone says what it has once it runs the latest Justus and connects to yours.
                </p>`
            : null
        }
        ${
          rows.former.length > 0
            ? html`<h4 class="ui-label mt-4">No longer in this album</h4>
                <ul>
                  ${rows.former.map((name) =>
                    personRow(
                      name,
                      "Has a copy from before. Removing someone does not take it back.",
                    ),
                  )}
                </ul>`
            : null
        }
      </div>
      <div class="mt-4 flex justify-end">
        <button
          class="ui-btn-ghost"
          ${ref((el) => el instanceof HTMLElement && queueMicrotask(() => el.focus()))}
          @click=${closeHolders}
        >
          Close
        </button>
      </div>
    </div>
  </div>`;
}
