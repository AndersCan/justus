import { html, type TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { keyed } from "lit-html/directives/keyed.js";
import type { HolderMember, Photo } from "@justus/core";
import { lightboxActor, lightboxEvents } from "../machines/lightbox-machine";
import { holdersLine, holdersSheetRows } from "../utils/holders";
import { nameList, shownName } from "../utils/people";
import { formatDay } from "../utils/time";
import { memberBadge } from "./avatar";
import { modalDialog } from "./modal-dialog";

import { copy, t } from "../copy/copy";
/** The "who has this photo" row on photo detail, and the sheet it opens. */

const holdersModal = modalDialog(() => document.querySelector("[data-holders-row]") ?? undefined);

export function openHolders(): void {
  lightboxActor.send(lightboxEvents.holdersOpened.create());
}

/** Close the sheet; focus goes back to the row that opened it. */
export function closeHolders(): void {
  lightboxActor.send(lightboxEvents.holdersClosed.create());
}

/** A row at least 44px tall; long lines wrap rather than get cut. */
export function holdersRow(photo: Photo, now: number) {
  const { text, tappable } = holdersLine(photo.holders, now);
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
    data-holders-row
    aria-label=${copy("photo_holders.show_who_has_this_photo", { text })}
    @click=${openHolders}
  >
    ${body}<span class="text-muted" aria-hidden="true">›</span>
  </button>`;
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

export function holdersSheet(
  photo: Photo,
  who: { yourName: string; friends: Readonly<Record<string, string>> },
  now = Date.now(),
) {
  const rows = holdersSheetRows(photo.holders);
  const resolve = (m: HolderMember) => {
    const name = shownName(m, who.friends);
    return { name, badge: memberBadge(name, m.color) };
  };
  const others = rows.others.map((m) => resolve(m));
  const quiet = rows.quiet.map((m) => ({ ...resolve(m), lastSeenAt: m.lastSeenAt }));
  const waiting = rows.waiting.map((m) => resolve(m));
  const unsure = rows.unsure.map((m) => resolve(m));
  const previews = rows.previews.map((m) => resolve(m));
  const youName = copy("photo_holders.you");
  const yourColor = photo.holders?.kind === "inAlbum" ? photo.holders.yourColor : undefined;
  const youBadge = memberBadge(who.yourName || youName, yourColor);
  const sources = [
    ...others.map((r) => r.name),
    ...(rows.youArriving ? [] : [copy("photo_holders.you_in_a_sentence")]),
  ];
  return html`<dialog
    class="ui-sheet-dialog"
    aria-label=${copy("photo_holders.who_has_this_photo")}
    ${ref(holdersModal)}
  >
    <div class="justus-sheet ui-sheet">
      <h3 class="text-base font-semibold text-fg">${t("photo_holders.who_has_this_photo")}</h3>
      <div class="max-h-[60vh] overflow-y-auto">
        ${
          !rows.youArriving || others.length > 0
            ? html`<h4 class="ui-label">${t("full_photo.has")}</h4>
                <ul>
                  ${rows.youArriving ? null : personRow(youName, youBadge)}
                  ${others.map((r) => personRow(r.name, r.badge))}
                </ul>`
            : null
        }
        ${
          quiet.length > 0
            ? html`<h4 class="ui-label mt-4">${t("photo_holders.last_had_full_photo")}</h4>
                <ul>
                  ${quiet.map((r) =>
                    personRow(
                      r.name,
                      r.badge,
                      copy("photo_holders.last_confirmed", { when: formatDay(r.lastSeenAt, now) }),
                    ),
                  )}
                </ul>
                <p class="text-xs text-muted">
                  ${t("photo_holders.off_or_wiped", { names: nameList(quiet.map((r) => r.name)) })}
                </p>`
            : null
        }
        ${
          previews.length > 0
            ? html`<h4 class="ui-label mt-4">${t("full_photo.only_preview")}</h4>
                <ul>
                  ${previews.map((r) => personRow(r.name, r.badge))}
                </ul>
                <p class="text-xs text-muted">${t("photo_holders.preview_is_a_small_copy")}</p>`
            : null
        }
        ${
          rows.youArriving || rows.waiting.length > 0
            ? html`<h4 class="ui-label mt-4">${t("full_photo.lacks")}</h4>
                ${
                  sources.length > 0
                    ? html`<p class="text-xs text-muted">
                        ${t("photo_holders.can_still_get_it_from", { names: nameList(sources) })}
                      </p>`
                    : null
                }
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
                      copy("photo_holders.has_the_full_photo_from"),
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
      <p class="mt-3 text-sm text-muted">
        ${t("photo_holders.no_server_keeps_a_copy")}
        ${t("photo_holders.copies_outside_justus_not_listed")}
      </p>
      <div class="mt-4 flex justify-end">
        <button class="ui-btn-ghost" data-dismiss autofocus @click=${closeHolders}>
          ${t("photo_holders.close")}
        </button>
      </div>
    </div>
  </dialog>`;
}
