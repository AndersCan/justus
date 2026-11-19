import { foldersActor, foldersViewModel } from "../machines/folders-machine";
import { galleryActor, galleryViewModel } from "../machines/gallery-machine";
import { currentPage, onPageChange } from "../machines/router-machine";
import { seen, seenActor, seenReady } from "../machines/seen-machine";
import { photosInScope } from "../utils/photo-scope";
import { flushLooked } from "./looked-at";

/** Leaving a page ends the visit: what was looked at stops being new. */
onPageChange(() => {
  flushLooked();
  seen.visitEnded();
});

/** Albums with photos that this phone has no record of yet get one, so their photos are not new. */
function listAlbums() {
  if (seenReady(seenActor.snapshot()) !== "ready") return;
  const gallerySnap = galleryActor.snapshot();
  const foldersSnap = foldersActor.snapshot();
  if (!galleryViewModel(gallerySnap, null).settled || !foldersViewModel(foldersSnap).settled)
    return;
  const known = seenActor.snapshot().context.known;
  const albums = foldersSnap.context.folders
    .filter((folder) => known[folder.id] === undefined)
    .map((folder) => ({
      albumId: folder.id,
      photoIds: photosInScope(gallerySnap.context.photos, { kind: "album", id: folder.id }).map(
        (p) => p.id,
      ),
    }))
    .filter((a) => a.photoIds.length > 0);
  if (albums.length > 0) seen.albumsListed(albums);
}

let opened: string | undefined;

/** The album page on screen saves its photos as known and is remembered as the last album, once per visit, after its photos are listed. */
function markOpened() {
  const page = currentPage();
  if (page?.route !== "photoAlbum") {
    opened = undefined;
    return;
  }
  const albumId = page.params.id;
  if (opened === albumId || seenReady(seenActor.snapshot()) !== "ready") return;
  const folder = foldersActor.snapshot().context.folders.find((x) => x.id === albumId);
  if (folder === undefined || folder.notice?.kind === "removed") return;
  const gallerySnap = galleryActor.snapshot();
  if (!galleryViewModel(gallerySnap, null).settled) return;
  opened = albumId;
  const photos = photosInScope(gallerySnap.context.photos, { kind: "album", id: albumId });
  seen.albumOpened(
    albumId,
    photos.map((p) => p.id),
  );
}

function onChange() {
  listAlbums();
  markOpened();
}

seenActor.on("change", { fn: onChange });
galleryActor.on("change", { fn: onChange });
foldersActor.on("change", { fn: onChange });
onPageChange(() => {
  opened = undefined;
  markOpened();
});
