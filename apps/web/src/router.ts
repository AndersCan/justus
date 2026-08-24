import { createRouter } from "@nanostores/router";

export const $router = createRouter({
  gallery: "/",
  albums: "/albums",
  settings: "/settings",
  requests: "/requests",
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
