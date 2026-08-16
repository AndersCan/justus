import { html } from "lit-html";
import { atom } from "nanostores";
import type { Photo } from "@justus/core";
import { $galleryState, $photos, gallery } from "../machines/gallery-machine";
import { useStore } from "../use-store";
import { formatFullDate, formatRelative } from "../utils/time";
import { memberColor } from "../utils/palette";
import { confirmAction } from "./confirm";
import { toast } from "./toast";

/** Full-screen photo detail. UI-only state — the machines stay untouched. */

export const $lightbox = atom<Photo | null>(null);

export function openLightbox(photo: Photo): void {
  $lightbox.set(photo);
}

export function closeLightbox(): void {
  $lightbox.set(null);
}

function step(dir: 1 | -1): void {
  const current = $lightbox.get();
  if (!current) return;
  const photos = $photos.get();
  const i = photos.findIndex((p) => p.id === current.id);
  if (i === -1) return;
  $lightbox.set(photos[(i + dir + photos.length) % photos.length]);
}

// A swipe must not also fire the backdrop's click (browsers synthesize a
// click after touchend on the touched element).
let suppressClickUntil = 0;

document.addEventListener("keydown", (e) => {
  if (!$lightbox.get()) return;
  if (e.key === "Escape") $lightbox.set(null);
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

async function removeFromLightbox(photo: Photo) {
  if ($galleryState.get() === "removing") return;
  const ok = await confirmAction({
    title: `Remove “${photo.name}”?`,
    detail: "It will disappear from every device sharing this folder.",
    confirmLabel: "Remove",
    tone: "brick",
  });
  if (!ok) return;
  gallery.remove(photo.id);
  $lightbox.set(null);
  toast(`Removed “${photo.name}”`);
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
      class="fixed inset-0 z-30 flex touch-pan-y flex-col bg-ink/80 backdrop-blur-sm"
      @click=${() => {
        if (Date.now() < suppressClickUntil) return;
        closeLightbox();
      }}
      @touchstart=${onTouchStart}
      @touchend=${onTouchEnd}
    >
      <button
        class="flex h-11 w-11 items-center justify-center rounded-full text-lg text-linen hover:bg-ink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linen/80"
        style="top: max(0.75rem, env(safe-area-inset-top)); right: 0.75rem"
        aria-label="Close"
        @click=${() => closeLightbox()}
      >
        ✕
      </button>

      <button
        class="absolute left-1 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-linen/90 px-3 py-2 text-ink shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linen/80 sm:block"
        aria-label="Previous photo"
        @click=${(e: Event) => {
          e.stopPropagation();
          step(-1);
        }}
      >
        ‹
      </button>
      <button
        class="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-linen/90 px-3 py-2 text-ink shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linen/80 sm:block"
        aria-label="Next photo"
        @click=${(e: Event) => {
          e.stopPropagation();
          step(1);
        }}
      >
        ›
      </button>

      <div class="flex flex-1 items-center justify-center p-4">
        <img
          class="max-h-[72vh] max-w-full rounded-2xl object-contain shadow-2xl"
          src="${photo.url}"
          alt="${photo.name}"
          referrerpolicy="no-referrer"
        />
      </div>

      <div
        class="mx-auto w-full max-w-2xl px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="rounded-2xl bg-linen p-4 shadow-lg ring-1 ring-line">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate font-serif text-lg text-ink">${photo.name}</div>
              <div class="mt-0.5 flex items-center gap-1.5 text-xs text-taupe">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-full"
                  style="background: ${memberColor(photo.member.key)}"
                ></span>
                <span class="truncate">${photo.member.name}</span>
                <span>·</span>
                <span title="${formatFullDate(photo.addedAt)}"
                  >${formatRelative(photo.addedAt)}</span
                >
              </div>
            </div>
            ${useStore(
              $galleryState,
              (state) => html`<button
                class="warm-ghost !bg-transparent !px-3 !text-brick hover:!bg-brick/10"
                ?disabled=${state === "removing"}
                @click=${() => void removeFromLightbox(photo)}
              >
                ${state === "removing" ? "Removing…" : "Remove"}
              </button>`,
            )}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function lightboxView() {
  return useStore($lightbox, (photo) => (photo ? lightboxBody(photo) : null));
}
