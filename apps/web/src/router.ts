import { createRouter } from "@nanostores/router";

export const $router = createRouter({
  gallery: "/",
  albums: "/albums",
  sharing: "/sharing",
  help: "/help",
  settings: "/settings",
  welcome: "/welcome",
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
