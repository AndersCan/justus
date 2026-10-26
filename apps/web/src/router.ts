import { createRouter } from "@nanostores/router";

export const $router = createRouter({
  gallery: "/",
  sharing: "/sharing",
  settings: "/settings",
  requests: "/requests",
  welcome: "/welcome",
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
