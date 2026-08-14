import { html } from "lit-html";
import { mediaEvents } from "@ekrooh/bare/plugins/media/events";
import type { Photo } from "@justus/core";
import { bus } from "../gateway";
import {
  $galleryError,
  $galleryViewModel,
  gallery,
  type GalleryStateName,
} from "../machines/gallery-machine";
import { useStore } from "../use-store";

async function pickAndAdd() {
  const [err, result] = await bus.invoke(mediaEvents.media.pick("image"));
  if (err || !result?.path) {
    // On the dev backend there is no host picker — surface the hint instead.
    $galleryError.set(
      `Pick failed: ${err?.message ?? "no path"}. In dev, drop a photo into the backend inbox and hit Refresh.`,
    );
    return;
  }
  gallery.add(result.path);
}

type GalleryViewModel = {
  state: GalleryStateName;
  busy: boolean;
  error: string | null;
  photos: Photo[];
};

function galleryBody({ state, busy, error, photos }: GalleryViewModel) {
  return html`
    <div class="space-y-5">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold">Gallery</h1>
        <div class="flex gap-2">
          <button
            class="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            ?disabled=${busy || state === "loading"}
            @click=${() => void pickAndAdd()}
          >
            Pick photo
          </button>
          <button
            class="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
            ?disabled=${busy || state === "loading"}
            @click=${() => gallery.load()}
          >
            Refresh
          </button>
        </div>
      </div>

      ${
        error
          ? html`<div
              class="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300"
            >
              ${error}
              ${
                state === "error"
                  ? html`<button class="ml-2 underline" @click=${() => gallery.retry()}>
                      Retry
                    </button>`
                  : null
              }
            </div>`
          : null
      }
      ${state === "loading" ? html`<p class="text-zinc-400">Loading…</p>` : null}
      ${
        state === "error" && !error
          ? html`<p class="text-zinc-400">Could not load the gallery.</p>`
          : null
      }

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" aria-label="Photos">
        ${photos.map(
          (photo) => html`
            <figure class="group relative overflow-hidden rounded-lg border border-zinc-800">
              <img
                class="aspect-square w-full object-cover"
                src="${photo.url}"
                alt="${photo.name}"
                referrerpolicy="no-referrer"
                loading="lazy"
              />
              <figcaption
                class="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-xs text-zinc-200"
              >
                <div class="truncate font-medium">${photo.name}</div>
                <div class="truncate text-zinc-400">
                  ${photo.member.name} · ${new Date(photo.addedAt).toLocaleDateString()}
                </div>
              </figcaption>
              <button
                class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-zinc-200 opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100 focus-visible:opacity-100"
                title="Remove ${photo.name}"
                aria-label="Remove ${photo.name}"
                ?disabled=${busy}
                @click=${() => gallery.remove(photo.id)}
              >
                ×
              </button>
            </figure>
          `,
        )}
      </div>

      ${
        photos.length === 0 && state === "ready"
          ? html`<p class="text-zinc-400">
              No photos yet. Pick one, or drop files into the dev inbox.
            </p>`
          : null
      }
    </div>
  `;
}

export function galleryView() {
  return useStore($galleryViewModel, (vm) => galleryBody(vm));
}
