import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import type { Photo } from "@justus/core";
import {
  GALLERY_STATES,
  gallery,
  galleryActor,
  galleryViewModel,
} from "../machines/gallery-machine";
import { lightboxActor, lightboxEvents } from "../machines/lightbox-machine";
import { formatFullDate, formatRelative } from "../utils/time";
import { takenTime } from "../utils/photo-scope";
import { memberColor } from "../utils/palette";
import { confirmAction } from "./confirm";
import { onStateChange } from "../machines/actor-utils";
import { foldersActor } from "../machines/folders-machine";
import { canRemove, roleFor, whyNoDelete } from "../utils/can-remove";
import { toast } from "./toast";
import { deleteDetail } from "../utils/holders";
import { holdersRow, holdersSheet, closeHolders } from "./photo-holders";

import { copy, t } from "../copy/copy";
/** Full-screen photo detail. The open photo lives in the lightbox machine. */

export function openLightbox(photo: Photo, within?: Photo[]): void {
  lightboxActor.send(lightboxEvents.opened.create({ photo, within }));
}

export function closeLightbox(): void {
  lightboxActor.send(lightboxEvents.closed.create());
}

/** Steps through the grid the lightbox was opened from, else every photo. */
export function step(dir: 1 | -1): void {
  const photos =
    lightboxActor.snapshot().context.sequence ?? galleryActor.snapshot().context.photos;
  lightboxActor.send(lightboxEvents.stepped.create({ dir, photos }));
}

// A photo deleted elsewhere must not stay open: tell the lightbox whenever the album's list is replaced.
let lastPhotos = galleryActor.snapshot().context.photos;
galleryActor.on("change", {
  fn: (s) => {
    if (s.context.photos === lastPhotos) return;
    lastPhotos = s.context.photos;
    if (lightboxActor.snapshot().context.photo) {
      lightboxActor.send(lightboxEvents.photoListChanged.create({ photos: s.context.photos }));
    }
  },
});

// A swipe must not also fire the backdrop's click (browsers synthesize a
// click after touchend on the touched element).
let suppressClickUntil = 0;

// The web unit suite runs in node (no DOM) and must stay import-safe, so only
// wire the global key handler where a document exists. The handler no-ops when
// no photo is open.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("wa-dropdown[open], wa-dialog[open]")) return;
    if (!lightboxActor.snapshot().context.photo) return;
    if (lightboxActor.snapshot().path[0] === "showingWhoHasThisPhoto") {
      if (e.key === "Escape") closeHolders();
      return;
    }
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
}

export async function deleteFromLightbox(photo: Photo) {
  if (gallery.state() === "removingPhoto") return;
  const ok = await confirmAction({
    title: copy("lightbox.delete", { name: photo.name }),
    detail: deleteDetail(photo.holders),
    confirmLabel: copy("lightbox.delete_2"),
    tone: "danger",
  });
  if (!ok) return;
  gallery.remove(photo.id, photo.folderId);
  // The view stays open until the album answers: success drops the photo and closes it.
  const stop = onStateChange(galleryActor, GALLERY_STATES, (next) => {
    if (next === "removingPhoto") return;
    stop();
    if (next === "couldNotRemovePhoto")
      toast(copy("lightbox.couldn_t_delete_try_again", { name: photo.name }));
  });
}

function lightboxBody(photo: Photo) {
  let touchStart: { x: number; y: number } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      suppressClickUntil = Date.now() + 350;
      step(dx < 0 ? 1 : -1);
    }
  };
  return html`
    <div
      class="fixed inset-0 z-30 flex touch-pan-y flex-col bg-black/80 backdrop-blur-sm"
      @click=${() => {
        if (Date.now() < suppressClickUntil) return;
        closeLightbox();
      }}
      @touchstart=${onTouchStart}
      @touchend=${onTouchEnd}
    >
      <button
        class="flex h-11 w-11 items-center justify-center rounded-full text-lg text-white hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        style="top: max(0.75rem, env(safe-area-inset-top)); right: 0.75rem"
        aria-label=${copy("lightbox.close")}
        @click=${() => closeLightbox()}
      >
        ✕
      </button>

      <button
        class="absolute left-1 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-surface/90 px-3 py-2 text-fg shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:block"
        aria-label=${copy("lightbox.previous_photo")}
        @click=${(e: Event) => {
          e.stopPropagation();
          step(-1);
        }}
      >
        ‹
      </button>
      <button
        class="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-surface/90 px-3 py-2 text-fg shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 sm:block"
        aria-label=${copy("lightbox.next_photo")}
        @click=${(e: Event) => {
          e.stopPropagation();
          step(1);
        }}
      >
        ›
      </button>

      <div class="flex flex-1 items-center justify-center p-4">
        <img
          class="max-h-[min(72vh,calc(100dvh-17rem))] max-w-full rounded-2xl object-contain shadow-2xl"
          src="${photo.url}"
          alt="${photo.name}"
          referrerpolicy="no-referrer"
        />
      </div>

      <div
        class="mx-auto w-full max-w-2xl px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="rounded-2xl bg-surface p-4 shadow-lg ring-1 ring-line">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate  text-lg text-fg">${photo.name}</div>
              <div class="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-full"
                  style="background: ${memberColor(photo.member.key)}"
                ></span>
                <span class="truncate">${photo.member.name}</span>
                <span>·</span>
                <span title="${formatFullDate(photo.addedAt)}"
                  >${t("lightbox.added", { when: formatRelative(photo.addedAt) })}</span
                >
              </div>
              ${
                photo.takenAt
                  ? html`<div class="mt-0.5 text-xs text-muted">
                      ${t("lightbox.taken", { date: formatFullDate(takenTime(photo)) })}
                    </div>`
                  : null
              }
              ${watch(foldersActor, (f) => {
                const why = whyNoDelete(
                  photo,
                  f.context.folders.find((x) => x.id === photo.folderId),
                );
                if (why === undefined) return null;
                return html`<div class="mt-0.5 text-xs text-muted">
                  ${why === "viewer" ? t("lightbox.who_deletes_viewer") : t("lightbox.who_deletes_adder_admin")}
                </div>`;
              })}
            </div>
            ${watch(foldersActor, (f) =>
              canRemove(photo, roleFor(photo, f.context.folders))
                ? watch(galleryActor, (s) => {
                    const removing = galleryViewModel(s, null).state === "removingPhoto";
                    return html`<wa-dropdown
                      placement="top-end"
                      @wa-select=${(e: CustomEvent<{ item: { value: string } }>) => {
                        if (e.detail.item.value === "delete") void deleteFromLightbox(photo);
                      }}
                    >
                      <button
                        slot="trigger"
                        class="ui-focus flex h-11 w-11 items-center justify-center rounded-full text-fg hover:bg-subtle"
                        aria-label=${copy("lightbox.more_options")}
                      >
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <circle cx="5" cy="12" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="19" cy="12" r="2" />
                        </svg>
                      </button>
                      <wa-dropdown-item value="delete" variant="danger" ?disabled=${removing}>
                        <svg
                          slot="icon"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                        ${removing ? copy("lightbox.deleting") : copy("lightbox.delete_2")}
                      </wa-dropdown-item>
                    </wa-dropdown>`;
                  })
                : null,
            )}
          </div>
          ${holdersRow(photo)}
        </div>
      </div>
    </div>
  `;
}

export function lightboxView() {
  return watch(lightboxActor, (s) =>
    s.context.photo
      ? html`${lightboxBody(s.context.photo)}${s.path[0] === "showingWhoHasThisPhoto" ? holdersSheet(s.context.photo) : null}`
      : null,
  );
}
