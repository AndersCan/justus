import { createRouter } from "@nanostores/router";

// The build uses relative asset URLs (`base: "./"`, for the native hosts), so a
// page loaded directly at a nested path can't find its assets. Keep pages that
// are linked or reloaded directly (tabs) to one path segment.

export const $router = createRouter({
  gallery: "/",
  mine: "/mine",
  photoAlbums: "/albums",
  photoAlbum: "/albums/:id",
  sharing: "/sharing",
  sharingJoin: "/join",
  sharingDevices: "/devices",
  album: "/sharing/:id",
  help: "/help",
  settings: "/settings",
  welcome: "/welcome",
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
