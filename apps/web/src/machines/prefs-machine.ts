import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";
import { readDensity, writeDensity, type Density } from "../utils/gallery-density";
import { readPhotoSort, writePhotoSort } from "../utils/photo-sort";
import type { PhotoSort } from "../utils/photo-scope";
import { readProfilePicture, writeProfilePicture } from "../utils/profile-picture";
import { readTheme, writeTheme, type Theme } from "../utils/theme";

/** This device's own choices: timeline, grid density, theme and profile picture. */

type PrefsContext = { sort: PhotoSort; density: Density; theme: Theme; picture: string };

/** The timeline was switched between date added and date taken. */
const sortChosen = event("SORT_CHOSEN")<{ sort: PhotoSort }>();
/** The photo grid density was changed. */
const densityChosen = event("DENSITY_CHOSEN")<{ density: Density }>();
/** The theme was changed. */
const themeChosen = event("THEME_CHOSEN")<{ theme: Theme }>();
/** The profile picture was set; an empty string means it was removed. */
const pictureSet = event("PICTURE_SET")<{ dataUrl: string }>();

/** Preferences are loaded and can be changed at any time. */
const holdingPreferences = state("holdingPreferences")();

export function createPrefsActor(options: { clock: Clock }) {
  return Actor({
    inputs: [sortChosen, densityChosen, themeChosen, pictureSet],
    internal: [],
    outputs: [],
    states: [holdingPreferences],
    initial: holdingPreferences,
    clock: options.clock,
    context: {
      sort: readPhotoSort(),
      density: readDensity(),
      theme: readTheme(),
      picture: readProfilePicture(),
    } as PrefsContext,
    setup: (m) => {
      /** The timeline choice is remembered. */
      m.onAny({
        event: sortChosen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), sort: e.payload.sort });
          return {};
        },
      });
      /** The density choice is remembered. */
      m.onAny({
        event: densityChosen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), density: e.payload.density });
          return {};
        },
      });
      /** The theme choice is remembered. */
      m.onAny({
        event: themeChosen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), theme: e.payload.theme });
          return {};
        },
      });
      /** The picture is replaced, or removed when empty. */
      m.onAny({
        event: pictureSet,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), picture: e.payload.dataUrl });
          return {};
        },
      });
    },
  });
}

export const prefsActor = createPrefsActor({ clock: RealClock() });

/** Each command saves to this device first, then updates what the screens show. */
export const prefs = {
  setSort(sort: PhotoSort) {
    writePhotoSort(sort);
    prefsActor.send(sortChosen.create({ sort }));
  },
  setDensity(density: Density) {
    writeDensity(density);
    prefsActor.send(densityChosen.create({ density }));
  },
  setTheme(theme: Theme) {
    writeTheme(theme);
    prefsActor.send(themeChosen.create({ theme }));
  },
  /** Returns false when storage refused the picture; nothing changes then. */
  setPicture(dataUrl: string): boolean {
    if (!writeProfilePicture(dataUrl)) return false;
    prefsActor.send(pictureSet.create({ dataUrl }));
    return true;
  },
};
