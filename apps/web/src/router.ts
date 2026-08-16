import { createRouter } from "@nanostores/router";

export const $router = createRouter({
  gallery: "/",
  settings: "/settings",
  requests: "/requests",
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
