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

/** No photo is open. */
const closedState = state("closed")();
/** A photo is open full-screen. */
const openState = state("open")();

export function createLightboxActor(options: { clock: Clock }) {
  return Actor({
    inputs: [opened, closed, stepped],
    internal: [],
    outputs: [],
    states: [closedState, openState],
    initial: closedState,
    clock: options.clock,
    context: { photo: undefined, sequence: undefined } as LightboxContext,
    setup: (m) => {
      for (const at of [closedState, openState]) {
        /** Opening a photo works from any state; it also replaces the open photo. */
        m.on(at, {
          event: opened,
          to: [openState],
          handler: (e, opts) => {
            opts.context.set({ photo: e.payload.photo, sequence: e.payload.within });
            return { state: openState };
          },
        });
      }
      /** Closing forgets the photo and its grid. */
      m.on(openState, {
        event: closed,
        to: [closedState],
        handler: (_e, opts) => {
          opts.context.set({ photo: undefined, sequence: undefined });
          return { state: closedState };
        },
      });
      /** Stepping stays open; a photo that is no longer in the list is left as it is. */
      m.on(openState, {
        event: stepped,
        handler: (e, opts) => {
          const c = opts.context.get();
          const { photos, dir } = e.payload;
          if (!c.photo) return {};
          const current = c.photo;
          const i = photos.findIndex((p) => samePhoto(p, current));
          if (i === -1) return {};
          opts.context.set({ ...c, photo: photos[(i + dir + photos.length) % photos.length] });
          return {};
        },
      });
    },
  });
}

export const lightboxActor = createLightboxActor({ clock: RealClock() });

export const lightboxEvents = { opened, closed, stepped };
