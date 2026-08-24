import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { atom } from "nanostores";
import type { Photo } from "@justus/core";
import { $photos } from "../machines/gallery-machine";
import { useStore } from "../use-store";
import { albums, $albumsViewModel } from "../machines/albums-machine";
import { confirmAction } from "./confirm";
import { toast } from "./toast";

/** New-album name field (kept in an atom so the input is controlled). */
const $newName = atom("");
const newNameRef = createRef<HTMLInputElement>();

function submitNew(e: Event) {
  e.preventDefault();
  const name = $newName.get().trim();
  if (!name) return;
  albums.create(name);
  $newName.set("");
  if (newNameRef.value) newNameRef.value.value = "";
}

/** A photo tile used while picking members: clicking toggles membership. */
function selectableTile(photo: Photo, selected: boolean, onToggle: () => void) {
  return html`
    <button
      type="button"
      class="group relative m-0 block w-full overflow-hidden bg-ink text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/60 focus-visible:ring-inset"
      aria-pressed=${selected}
      aria-label="${selected ? "Remove" : "Add"} ${photo.name}"
      @click=${onToggle}
    >
      <img
        class="aspect-square w-full object-cover transition duration-200 ${
          selected ? "opacity-60" : "group-hover:brightness-90"
        }"
        src="${photo.url}"
        alt="${photo.name}"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
      <span
        class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-sm ${
          selected ? "bg-clay text-linen" : "bg-ink/60 text-linen backdrop-blur-sm"
        }"
        aria-hidden="true"
        >${selected ? "✓" : "+"}</span
      >
    </button>
  `;
}

/** Tile for a photo already in the album — click removes it. */
function albumPhotoTile(photo: Photo) {
  return html`
    <figure class="group relative m-0 overflow-hidden bg-ink">
      <img
        class="aspect-square w-full object-cover"
        src="${photo.url}"
        alt="${photo.name}"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
      <button
        class="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-ink/60 text-sm text-linen backdrop-blur-sm transition hover:bg-brick focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linen/60"
        title="Remove ${photo.name} from album"
        aria-label="Remove ${photo.name} from album"
        @click=${() => albums.removePhoto(photo.id)}
      >
        <svg
          width="14"
          height="14"
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
      </button>
    </figure>
  `;
}

function albumList() {
  return html`
    <ul class="flex flex-col gap-1">
      ${useStore($albumsViewModel, (vm) =>
        vm.albums.length === 0
          ? html`<li class="text-sm text-taupe">No albums yet.</li>`
          : vm.albums.map(
              (album) => html`
                <li class="flex items-center gap-1">
                  <button
                    type="button"
                    class="flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm ${
                      vm.activeId === album.id
                        ? "bg-butter font-semibold text-clay"
                        : "text-cocoa hover:bg-linen"
                    }"
                    aria-current=${vm.activeId === album.id ? "page" : undefined}
                    @click=${() => albums.open(album.id)}
                  >
                    ${album.name}
                    <span class="ml-1 text-xs text-taupe">${album.photoIds.length}</span>
                  </button>
                  <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-taupe hover:bg-linen hover:text-clay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
                    title="Delete ${album.name}"
                    aria-label="Delete ${album.name}"
                    @click=${() =>
                      void confirmAction({
                        title: `Delete the album “${album.name}”?`,
                        detail: "Photos are not removed from the folder.",
                        confirmLabel: "Delete",
                        tone: "brick",
                      }).then((ok) => {
                        if (ok) albums.remove(album.id);
                      })}
                  >
                    <svg
                      width="15"
                      height="15"
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
                    </svg>
                  </button>
                </li>
              `,
            ),
      )}
    </ul>
  `;
}

function albumPanel() {
  return useStore($albumsViewModel, (vm) => {
    if (!vm.active) {
      return html`<p class="text-sm text-taupe">
        Pick an album on the left, or create one to start grouping photos.
      </p>`;
    }
    const ids = new Set(vm.active.photoIds);

    if (vm.addMode) {
      return useStore($photos, (photos) => {
        const remaining = photos.filter((p) => !ids.has(p.id));
        return html`
          <div class="mb-3 flex items-center justify-between">
            <h2 class="font-serif text-lg text-cocoa">Add photos to “${vm.active!.name}”</h2>
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-sm text-clay hover:bg-linen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
              @click=${() => albums.toggleAddMode()}
            >
              Done
            </button>
          </div>
          ${
            remaining.length === 0
              ? html`<p class="text-sm text-taupe">
                  Every photo in this folder is already in the album.
                </p>`
              : html`<div
                  class="grid grid-cols-3 gap-0 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
                >
                  ${remaining.map((photo) =>
                    selectableTile(photo, false, () => {
                      albums.addPhotos([photo.id]);
                      toast(`Added “${photo.name}”`);
                    }),
                  )}
                </div>`
          }
        `;
      });
    }

    return useStore($photos, (photos) => {
      const inAlbum = photos.filter((p) => ids.has(p.id));
      return html`
        <div class="mb-3 flex items-center justify-between">
          <h2 class="font-serif text-lg text-cocoa">
            ${vm.active!.name}
            <span class="ml-1 font-sans text-sm text-taupe">${inAlbum.length}</span>
          </h2>
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-sm text-clay hover:bg-linen focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
            @click=${() => albums.toggleAddMode()}
          >
            Add photos
          </button>
        </div>
        ${
          inAlbum.length === 0
            ? html`<p class="text-sm text-taupe">
                No photos yet — tap “Add photos” to group some from this folder.
              </p>`
            : html`<div class="grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                ${inAlbum.map(albumPhotoTile)}
              </div>`
        }
      `;
    });
  });
}

export function albumsView() {
  return html`
    <section class="grid gap-8 md:grid-cols-[16rem_1fr]">
      <aside>
        <h1 class="mb-3 font-serif text-2xl text-cocoa">Albums</h1>
        <form class="mb-4 flex gap-2" @submit=${submitNew}>
          <input
            ${ref(newNameRef)}
            class="min-w-0 flex-1 rounded-md border border-line bg-linen px-2 py-1.5 text-sm text-cocoa focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
            placeholder="New album name"
            aria-label="New album name"
            @input=${(e: Event) => $newName.set((e.target as HTMLInputElement).value)}
          />
          <button
            type="submit"
            class="rounded-md bg-clay px-3 py-1.5 text-sm font-medium text-linen hover:bg-clay/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40"
          >
            Add
          </button>
        </form>
        ${albumList()}
      </aside>
      <div>${albumPanel()}</div>
    </section>
  `;
}
