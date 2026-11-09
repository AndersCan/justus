import { html, type TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { keyed } from "lit-html/directives/keyed.js";
import type { Photo } from "@justus/core";
import { lightboxActor, lightboxEvents } from "../machines/lightbox-machine";
import { holdersLine, holdersSheetRows } from "../utils/holders";
import { nameList, type Person } from "../utils/people";
import { memberBadge } from "./avatar";

import { copy, t } from "../copy/copy";
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

/** A row at least 44px tall; long lines wrap rather than get cut. */
export function holdersRow(photo: Photo) {
  const { text, tappable } = holdersLine(photo.holders);
  const label = html`<span
    class="justus-holders-text min-w-0 flex-1 text-left text-xs ${
      tappable ? "text-fg" : "text-muted"
    }"
    aria-live="polite"
    >${text}</span
  >`;
  const body = keyed(text, label);
  if (!tappable) {
    return html`<div class="mt-3 flex min-h-11 items-center gap-2 border-t border-line py-1">
      ${body}
    </div>`;
  }
  return html`<button
    class="ui-focus -mx-2 mt-3 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-lg border-t border-line px-2 py-1 hover:bg-subtle"
    ${ROW_ATTR}
    aria-label=${copy("photo_holders.show_who_has_this_photo", { text })}
    @click=${openHolders}
  >
    ${body}<span class="text-muted" aria-hidden="true">›</span>
  </button>`;
}

/** A keyed row takes the name and colour it has on Members; a key not there keeps what the backend sent. */
function resolve(m: { key: string; name: string }, people: readonly Person[]) {
  const p = people.find((q) => q.key === m.key);
  return {
    name: p?.name ?? m.name,
    badge: p ? memberBadge(p.name, p.color) : memberBadge(m.name, undefined),
  };
}

function personRow(name: string, badge: TemplateResult, detail?: string) {
  return html`<li class="flex items-center gap-3 py-2">
    ${badge}
    <div class="min-w-0">
      <div class="truncate text-sm text-fg">${name}</div>
      ${detail ? html`<div class="text-xs text-muted">${detail}</div>` : null}
    </div>
  </li>`;
}

export function holdersSheet(photo: Photo, people: readonly Person[]) {
  const rows = holdersSheetRows(photo.holders);
  const others = rows.others.map((m) => resolve(m, people));
  const waiting = rows.waiting.map((m) => resolve(m, people));
  const unsure = rows.unsure.map((m) => resolve(m, people));
  const self = people.find((p) => p.you);
  const youName = copy("photo_holders.you");
  const youBadge = self ? memberBadge(self.name, self.color) : memberBadge(youName, undefined);
  const sources = [
    ...others.map((r) => r.name),
    ...(rows.youArriving ? [] : [copy("photo_holders.you_in_a_sentence")]),
  ];
  return html`<div
    class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
    @click=${closeHolders}
  >
    <div
      class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
      role="dialog"
      aria-modal="true"
      aria-label=${copy("photo_holders.who_has_this_photo")}
      @click=${(e: Event) => e.stopPropagation()}
    >
      <h3 class="text-base font-semibold text-fg">${t("photo_holders.who_has_this_photo")}</h3>
      <p class="text-xs text-muted">${t("photo_holders.phones_with_a_full_copy")}</p>
      <div class="max-h-[60vh] overflow-y-auto">
        <ul>
          ${rows.youArriving ? null : personRow(youName, youBadge)}
          ${others.map((r) => personRow(r.name, r.badge))}
        </ul>
        ${
          rows.youArriving || rows.waiting.length > 0
            ? html`<h4 class="mt-4 text-xs font-semibold text-muted">
                  ${
                    sources.length > 0
                      ? t("photo_holders.can_still_get_it_from", { names: nameList(sources) })
                      : t("photo_holders.not_on_their_phone_yet")
                  }
                </h4>
                <ul>
                  ${
                    rows.youArriving
                      ? personRow(youName, youBadge, copy("photo_holders.arriving"))
                      : null
                  }
                  ${waiting.map((r) => personRow(r.name, r.badge))}
                </ul>`
            : null
        }
        ${
          rows.unsure.length > 0
            ? html`<h4 class="ui-label mt-4">${t("photo_holders.hasn_t_said_yet")}</h4>
                <ul>
                  ${unsure.map((r) => personRow(r.name, r.badge))}
                </ul>
                <p class="text-xs text-muted">${t("photo_holders.a_phone_says_what_it")}</p>`
            : null
        }
        ${
          rows.former.length + rows.left.length > 0
            ? html`<h4 class="ui-label mt-4">${t("photo_holders.no_longer_in_this_album")}</h4>
                <ul>
                  ${rows.former.map((name) =>
                    personRow(
                      name,
                      memberBadge(name, undefined),
                      copy("photo_holders.has_a_copy_from_before"),
                    ),
                  )}
                  ${rows.left.map((name) =>
                    personRow(
                      name,
                      memberBadge(name, undefined),
                      copy("photo_holders.left_their_phone_deleted_its"),
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
          ${t("photo_holders.close")}
        </button>
      </div>
    </div>
  </div>`;
}
