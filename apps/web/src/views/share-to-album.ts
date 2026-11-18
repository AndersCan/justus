import { html, type TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { watch } from "@mantaq/lit";
import type { FolderSummary } from "@justus/core";
import { copy } from "../copy/copy";
import { foldersActor, foldersViewModel } from "../machines/folders-machine";
import { open } from "../machines/router-machine";
import {
  sharedPhotos,
  sharedPhotosActor,
  sharedPhotosViewOf,
} from "../machines/shared-photos-machine";
import { planAdd } from "../utils/add-photos";
import { roleAndCount } from "./albums";
import { modalDialog } from "./modal-dialog";
import { addPicked, addableAlbum } from "./photo-picker";
import { startAlbum } from "./start-album";

/** The albums shared photos can go into: the same rule as Add photos, minus albums she was removed from. */
export function addableAlbums(folders: FolderSummary[]): FolderSummary[] {
  return folders.filter(
    (f) => f.notice?.kind !== "removed" && planAdd(f.id, folders, null).kind === "direct",
  );
}

export type ShareSheetView = {
  count: number;
  /** "loading": the album list has not arrived; "failed": it could not be read. */
  albums: "loading" | "failed" | FolderSummary[];
};
export type ShareSheetActions = {
  add: (albumId: string) => void;
  create: () => void;
  notNow: () => void;
};

const sheetModal = modalDialog();

function albumRow(count: number, folder: FolderSummary, first: boolean, on: ShareSheetActions) {
  return html`<li>
    <button
      type="button"
      class="ui-focus w-full rounded-2xl border border-line p-4 text-left"
      aria-label=${copy("share_to_album.add_photos_to_album", { count, name: folder.name })}
      ?autofocus=${first}
      @click=${() => on.add(folder.id)}
    >
      <span class="block truncate text-lg font-medium text-fg">${folder.name}</span>
      <span class="mt-0.5 block truncate text-sm text-muted">${roleAndCount(folder)}</span>
    </button>
  </li>`;
}

/** The sheet's panel, from plain values (tested in happy-dom). */
export function shareSheetPanel(v: ShareSheetView, on: ShareSheetActions): TemplateResult {
  const title = copy("share_to_album.add_photos_to", { count: v.count });
  const { albums } = v;
  const noRows = Array.isArray(albums) && albums.length === 0;
  let body: unknown;
  if (albums === "loading") {
    body = html`<p class="mt-3 text-sm text-muted" role="status">${copy("gallery.loading")}</p>`;
  } else if (albums === "failed") {
    body = html`<p class="mt-3 text-sm text-muted">${copy("share_to_album.albums_not_read")}</p>`;
  } else if (noRows) {
    body = html`<p class="mt-1 text-sm text-muted">
      ${copy("share_to_album.no_album_you_can_add_to")}
    </p>`;
  } else {
    body = html`<ul class="mt-3 flex flex-col gap-2" aria-label=${title}>
      ${albums.map((f, i) => albumRow(v.count, f, i === 0, on))}
    </ul>`;
  }
  return html`<dialog class="ui-sheet-dialog" aria-label=${title} ${ref(sheetModal)}>
    <div class="justus-sheet ui-sheet">
      <h3 class="text-base font-semibold text-fg">${title}</h3>
      ${body}
      <div class="mt-4 flex justify-end gap-2">
        <button class="ui-btn-ghost" type="button" data-dismiss @click=${() => on.notNow()}>
          ${copy("share_to_album.not_now")}
        </button>
        ${
          noRows
            ? html`<button
                class="ui-btn-primary"
                type="button"
                autofocus
                @click=${() => on.create()}
              >
                ${copy("start_album.create_album")}
              </button>`
            : null
        }
      </div>
    </div>
  </dialog>`;
}

/** Every photo of every shown batch goes into the album; she lands in it to watch the add. */
export function addToAlbum(albumId: string) {
  const folderId = addableAlbum(albumId);
  if (!folderId) return;
  const sources = sharedPhotosViewOf(sharedPhotosActor.snapshot())
    .batches.flatMap((b) => b.photos)
    .map((p) => ({ kind: "path" as const, ...p }));
  if (!addPicked(folderId, sources, "shared")) return;
  sharedPhotos.addStarted(folderId);
  open("/albums/" + folderId);
}

export async function createAndAdd() {
  const { count } = sharedPhotosViewOf(sharedPhotosActor.snapshot());
  const id = await startAlbum(
    copy("share_to_album.start_one_for_them", { count }),
    copy("start_album.create_album"),
  );
  if (id) addToAlbum(id);
}

const actions: ShareSheetActions = {
  add: addToAlbum,
  create: () => void createAndAdd(),
  notNow: sharedPhotos.notNow,
};

/** The live sheet: open while the sharedPhotos machine asks. Rendered once, in main.ts. */
export function sharedPhotosSheet(): unknown {
  return watch(sharedPhotosActor, (s) => {
    const v = sharedPhotosViewOf(s);
    if (!v.asking) return null;
    return watch(foldersActor, (f) => {
      const vm = foldersViewModel(f);
      const albums =
        vm.state === "albumsNotLoaded" || vm.state === "loadingAlbums"
          ? "loading"
          : vm.state === "couldNotLoadAlbums" || vm.fatal
            ? "failed"
            : addableAlbums(vm.folders);
      return shareSheetPanel({ count: v.count, albums }, actions);
    });
  });
}
