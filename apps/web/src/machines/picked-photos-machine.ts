import { Actor, event, machine, state, type Snapshot } from "@mantaq/core";
import type { AddSource } from "./gallery-machine";

/**
 * Photos she picked on Photos > All or Added by me wait here, in picked order,
 * until she taps an album on the sheet. Cancelling drops them.
 */

export type PickedPhotosContext = { photos: AddSource[] };

/** No photos are held; no sheet. */
const noPickedPhotos = state("noPickedPhotos")();
/** The sheet "Add 5 photos to" is open over Photos, holding the photos in picked order. */
const choosingAlbumForPickedPhotos = state("choosingAlbumForPickedPhotos")();

/** She picked photos on Photos > All or Added by me. */
const photosPicked = event("PHOTOS_PICKED")<{ photos: AddSource[] }>();
/** The album she tapped took them; the gallery's batch holds them now. */
const addStarted = event("ADD_STARTED")();
/** She closed the sheet: Not now, Escape, Back or a tap outside. */
const cancelled = event("CANCEL")();

const initialContext: PickedPhotosContext = { photos: [] };

export const pickedPhotosMachine = machine("pickedPhotos", {
  create: () => {
    return Actor({
      inputs: [photosPicked, addStarted, cancelled],
      internal: [],
      outputs: [],
      states: [noPickedPhotos, choosingAlbumForPickedPhotos],
      initial: noPickedPhotos,
      context: initialContext,
      setup: (m) => {
        /** Picked photos are held and the sheet opens; an empty pick opens nothing. */
        m.on(noPickedPhotos, {
          event: photosPicked,
          to: [choosingAlbumForPickedPhotos],
          handler: (e, opts) => {
            if (e.payload.photos.length === 0) return {};
            opts.context.set({ photos: e.payload.photos });
            return { state: choosingAlbumForPickedPhotos };
          },
        });
        for (const ev of [addStarted, cancelled]) {
          /** The album took them, or she closed the sheet: nothing is held. */
          m.on(choosingAlbumForPickedPhotos, {
            event: ev,
            to: [noPickedPhotos],
            handler: (_e, opts) => {
              opts.context.set({ photos: [] });
              return { state: noPickedPhotos };
            },
          });
        }
      },
    });
  },
});

export const pickedPhotosActor = pickedPhotosMachine.create();

export const pickedPhotos = {
  picked: (photos: AddSource[]) => pickedPhotosActor.send(photosPicked.create({ photos })),
  addStarted: () => pickedPhotosActor.send(addStarted.create()),
  cancel: () => pickedPhotosActor.send(cancelled.create()),
};

/** What the sheet reads: open or not, and how many photos it holds. */
export function pickedPhotosViewOf(s: Snapshot<PickedPhotosContext>): {
  asking: boolean;
  count: number;
} {
  return {
    asking: s.path[0] === "choosingAlbumForPickedPhotos",
    count: s.context.photos.length,
  };
}
