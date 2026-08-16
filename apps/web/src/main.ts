import { html, render } from "lit-html";
import { cache } from "lit-html/directives/cache.js";
import { getPagePath } from "@nanostores/router";
// UnoCSS global mode: the generated stylesheet must be imported by the entry.
import "uno.css";
import { messenger, transport } from "./gateway";
import { handleMessage } from "./handle-message";
import { gallery } from "./machines/gallery-machine";
import { sync } from "./machines/sync-machine";
import { $router, type AppPage } from "./router";
import { useStore } from "./use-store";
import { galleryView } from "./views/gallery";
import { settingsView } from "./views/settings";

// The Android/iOS shells serve the app from a path ending in index.html —
// normalize to the gallery route so first load never lands on "Not found".
if (window.location.pathname.endsWith("/index.html")) {
  $router.open("/", true);
}

transport.subscribe((message) => {
  messenger.handleIncoming(message.header);
  handleMessage(message);
});

gallery.load();
sync.refresh();

const renderRoot = document.getElementById("render-root");

const cameraMark = html`<svg
  class="h-[18px] w-[18px]"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
  <circle cx="12" cy="13" r="4" />
</svg>`;

function navItem(page: AppPage | undefined, route: "gallery" | "settings", label: string) {
  const active = page?.route === route;
  return html`<a
    class="rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-lavpur-600 text-white shadow-soft"
        : "text-ink-700 hover:bg-mist-200 hover:text-ink-900"
    }"
    href="${getPagePath($router, route)}"
    aria-current=${active ? "page" : undefined}
    >${label}</a
  >`;
}

render(
  html`
    <div class="min-h-screen bg-paper bg-mist-100 font-body text-ink-900">
      <header class="sticky top-0 z-10 border-b border-mist-200 bg-mist-50/90 backdrop-blur-sm">
        <nav class="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 text-sm" aria-label="Main">
          <a href="${getPagePath($router, "gallery")}" class="mr-1 flex items-center gap-2.5">
            <span
              class="flex h-9 w-9 items-center justify-center rounded-full bg-lavpur-600 text-white shadow-soft"
              >${cameraMark}</span
            >
            <span class="font-display text-2xl font-bold tracking-tight text-ink-900">Justus</span>
          </a>
          <span class="flex items-center gap-1 rounded-full bg-mist-100 p-1 ring-1 ring-mist-200">
            ${useStore(
              $router,
              (page) =>
                html`${navItem(page, "gallery", "Gallery")}${navItem(page, "settings", "Sync")}`,
            )}
          </span>
        </nav>
      </header>
      <main class="mx-auto max-w-6xl px-4 py-8">
        ${useStore($router, (page) => cache(routeView(page)))}
      </main>
      <footer class="mx-auto max-w-6xl px-4 pb-10 pt-2 text-center">
        <p class="text-xs text-ink-500">Justus · your photos, cosy on every device you own</p>
      </footer>
    </div>
  `,
  renderRoot!,
);

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`<p class="text-ink-600">Not found.</p>`;
  }
  return page.route === "gallery" ? cache(galleryView()) : cache(settingsView());
}
