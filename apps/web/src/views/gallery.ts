import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import type { Photo } from "@justus/core";
import {
  $galleryError,
  $galleryViewModel,
  gallery,
  type AddFileInput,
  type GalleryStateName,
} from "../machines/gallery-machine";
import { useStore } from "../use-store";

/** In-band uploads share one protocol frame — stay comfortably under the
 * 16 MiB frame cap (header bytes included). Bigger files get a friendly
 * skip message; use the dev inbox / host picker for those. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const fileInputRef = createRef<HTMLInputElement>();

/** Reads every picked file and hands the whole batch to the gallery actor
 * (which uploads sequentially). The browser picker supports multi-select. */
async function pickAndAdd() {
  const input = fileInputRef.value;
  if (!input) return;
  const files = Array.from(input.files ?? []);
  input.value = ""; // allow re-selecting the same files next time
  if (files.length === 0) return;

  const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const ok = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);

  if (tooBig.length > 0 && ok.length === 0) {
    const names = tooBig
      .slice(0, 3)
      .map((f) => f.name)
      .join(", ");
    const more = tooBig.length > 3 ? ` and ${tooBig.length - 3} more` : "";
    $galleryError.set(
      `Skipped ${tooBig.length} photo${tooBig.length === 1 ? "" : "s"} over the 15 MiB upload limit: ${names}${more}.`,
    );
    return;
  }

  const inputs: AddFileInput[] = [];
  for (const file of ok) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      inputs.push({ name: file.name, bytes });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      $galleryError.set(`Could not read ${file.name}: ${message}`);
    }
  }
  if (inputs.length === 0) return;

  const notice =
    tooBig.length > 0
      ? `Skipped ${tooBig.length} photo${tooBig.length === 1 ? "" : "s"} over the 15 MiB upload limit`
      : undefined;
  gallery.addFiles(inputs, notice);
}

type GalleryViewModel = {
  state: GalleryStateName;
  busy: boolean;
  error: string | null;
  photos: Photo[];
};

function galleryBody({ state, busy, error, photos }: GalleryViewModel) {
  return html`
    <div class="space-y-8">
      <section class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="label mb-1">Your photo folder</p>
          <h1 class="font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
            Gallery
          </h1>
          <p class="mt-1.5 max-w-md text-sm text-ink-600">
            Every photo in your folder, in one cosy place — ready when you are.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input
            ${ref(fileInputRef)}
            class="hidden"
            type="file"
            accept="image/*"
            multiple
            aria-label="Pick photos"
            @change=${() => void pickAndAdd()}
          />
          <button
            class="btn-primary"
            ?disabled=${busy || state === "loading"}
            @click=${() => fileInputRef.value?.click()}
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add photos
          </button>
          <button
            class="btn-ghost"
            ?disabled=${busy || state === "loading"}
            @click=${() => gallery.load()}
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            Refresh
          </button>
        </div>
      </section>

      ${
        error
          ? html`<div
              class="flex items-start gap-3 rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-800 shadow-soft"
              role="alert"
            >
              <svg
                class="mt-0.5 h-4 w-4 shrink-0 text-coral-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <div class="min-w-0 flex-1">
                <p>${error}</p>
                ${
                  state === "error"
                    ? html`<button class="btn-link mt-1 text-xs" @click=${() => gallery.retry()}>
                        Retry
                      </button>`
                    : null
                }
              </div>
            </div>`
          : null
      }
      ${
        state === "loading"
          ? html`<div class="flex items-center gap-2.5 py-10 text-ink-600">
              <span
                class="h-5 w-5 animate-spin rounded-full border-2 border-mist-300 border-t-lavpur-600"
                aria-hidden="true"
              ></span>
              <span class="text-sm">Loading…</span>
            </div>`
          : null
      }
      ${
        state === "error" && !error
          ? html`<p class="py-10 text-sm text-ink-600">Could not load the gallery.</p>`
          : null
      }
      ${
        state !== "loading" || photos.length > 0
          ? html`<div
              class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
              aria-label="Photos"
            >
              ${photos.map(
                (photo) => html`
                  <figure
                    class="group relative overflow-hidden rounded-2xl border border-mist-200 bg-white/70 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg"
                  >
                    <img
                      class="aspect-square w-full object-cover"
                      src="${photo.url}"
                      alt="${photo.name}"
                      referrerpolicy="no-referrer"
                      loading="lazy"
                    />
                    <button
                      class="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/55 text-white opacity-0 shadow-soft transition-all duration-150 hover:bg-coral-600 group-hover:opacity-100 focus-visible:opacity-100"
                      title="Remove ${photo.name}"
                      aria-label="Remove ${photo.name}"
                      ?disabled=${busy}
                      @click=${() => gallery.remove(photo.id)}
                    >
                      <svg
                        class="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path
                          d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
                        />
                      </svg>
                    </button>
                    <figcaption
                      class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/75 via-ink-950/25 to-transparent px-3 pb-2.5 pt-10 text-white"
                    >
                      <div class="truncate text-sm font-medium drop-shadow-sm">${photo.name}</div>
                      <div class="truncate text-xs text-white/85">
                        ${photo.member.name} · ${new Date(photo.addedAt).toLocaleDateString()}
                      </div>
                    </figcaption>
                  </figure>
                `,
              )}
            </div>`
          : null
      }
      ${
        photos.length === 0 && state === "ready"
          ? html`<section
              class="card mx-auto flex max-w-md flex-col items-center gap-3 px-8 py-12 text-center"
            >
              <span
                class="flex h-16 w-16 items-center justify-center rounded-full bg-mist-100 text-ink-500"
                aria-hidden="true"
              >
                <svg
                  class="h-8 w-8"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </span>
              <h2 class="font-display text-xl font-bold text-ink-900">No photos yet</h2>
              <p class="text-sm text-ink-600">
                Pick a few to start your folder — select one or many at once.
              </p>
              <button class="btn-primary mt-1" @click=${() => fileInputRef.value?.click()}>
                Add your first photos
              </button>
            </section>`
          : null
      }
    </div>
  `;
}

export function galleryView() {
  return useStore($galleryViewModel, (vm) => galleryBody(vm));
}
