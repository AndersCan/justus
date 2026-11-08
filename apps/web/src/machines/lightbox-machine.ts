import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";
import type { Photo } from "@justus/core";
import { samePhoto } from "./gallery-machine";

/** Which photo is open full-screen, and the photos it steps through. */

type LightboxContext = { photo: Photo | undefined; sequence: Photo[] | undefined };

/** A photo was picked; `within` is the grid it sits in. */
const opened = event("OPEN")<{ photo: Photo; within: Photo[] | undefined }>();
/** The viewer was closed. */
const closed = event("CLOSE")();
/** Move to the next or previous photo, wrapping around. */
const stepped = event("STEP")<{ dir: 1 | -1; photos: Photo[] }>();

/** The album's photos were loaded again; a photo deleted elsewhere is no longer in them. */
const photoListChanged = event("PHOTO_LIST_CHANGED")<{ photos: Photo[] }>();

/** The "Who has this photo" sheet was opened over the photo. */
const holdersOpened = event("OPEN_HOLDERS")();
/** The "Who has this photo" sheet was closed. */
const holdersClosed = event("CLOSE_HOLDERS")();

/** No photo is open. */
const noPhotoOpen = state("noPhotoOpen")();
/** A photo is open full-screen. */
const showingPhoto = state("showingPhoto")();
/** A photo is open with the sheet of who has it over it. */
const showingWhoHasThisPhoto = state("showingWhoHasThisPhoto")();

export function createLightboxActor(options: { clock: Clock }) {
  return Actor({
    inputs: [opened, closed, stepped, photoListChanged, holdersOpened, holdersClosed],
    internal: [],
    outputs: [],
    states: [noPhotoOpen, showingPhoto, showingWhoHasThisPhoto],
    initial: noPhotoOpen,
    clock: options.clock,
    context: { photo: undefined, sequence: undefined } as LightboxContext,
    setup: (m) => {
      for (const at of [noPhotoOpen, showingPhoto, showingWhoHasThisPhoto]) {
        /** Opening a photo works from any state; it also replaces the open photo. */
        m.on(at, {
          event: opened,
          to: [showingPhoto],
          handler: (e, opts) => {
            opts.context.set({ photo: e.payload.photo, sequence: e.payload.within });
            return { state: showingPhoto };
          },
        });
      }
      m.on(showingPhoto, {
        event: holdersOpened,
        to: [showingWhoHasThisPhoto],
        handler: () => ({ state: showingWhoHasThisPhoto }),
      });
      m.on(showingWhoHasThisPhoto, {
        event: holdersClosed,
        to: [showingPhoto],
        handler: () => ({ state: showingPhoto }),
      });
      for (const at of [showingPhoto, showingWhoHasThisPhoto]) {
        /** Closing forgets the photo and its grid. */
        m.on(at, {
          event: closed,
          to: [noPhotoOpen],
          handler: (_e, opts) => {
            opts.context.set({ photo: undefined, sequence: undefined });
            return { state: noPhotoOpen };
          },
        });
        /** A new photo list: the view closes when its photo is gone; otherwise the open photo and the steps are the fresh objects, so live changes (who has it) reach the view. */
        m.on(at, {
          event: photoListChanged,
          to: [noPhotoOpen],
          handler: (e, opts) => {
            const c = opts.context.get();
            const { photos } = e.payload;
            const current = c.photo;
            const fresh = current ? photos.find((p) => samePhoto(p, current)) : undefined;
            if (!fresh) {
              opts.context.set({ photo: undefined, sequence: undefined });
              return { state: noPhotoOpen };
            }
            opts.context.set({
              photo: fresh,
              sequence: c.sequence
                ?.map((s) => photos.find((p) => samePhoto(p, s)))
                .filter((p): p is Photo => p !== undefined),
            });
            return {};
          },
        });
        /** Stepping stays open and closes the sheet; a photo that is no longer in the list is left as it is. */
        m.on(at, {
          event: stepped,
          to: [showingPhoto],
          handler: (e, opts) => {
            const c = opts.context.get();
            const { photos, dir } = e.payload;
            if (!c.photo) return {};
            const current = c.photo;
            const i = photos.findIndex((p) => samePhoto(p, current));
            if (i === -1) return {};
            opts.context.set({ ...c, photo: photos[(i + dir + photos.length) % photos.length] });
            return { state: showingPhoto };
          },
        });
      }
    },
  });
}

export const lightboxActor = createLightboxActor({ clock: RealClock() });

export const lightboxEvents = {
  opened,
  closed,
  stepped,
  photoListChanged,
  holdersOpened,
  holdersClosed,
};
