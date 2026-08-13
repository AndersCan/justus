import { html, render } from "lit-html";
import { cache } from "lit-html/directives/cache.js";
import { getPagePath } from "@nanostores/router";
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
render(
  html`
    <div class="min-h-screen bg-zinc-950 text-zinc-100">
      <header class="border-b border-zinc-800">
        <nav class="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3 text-sm" aria-label="Main">
          <span class="text-lg font-bold tracking-tight">Justus</span>
          <a class="hover:underline" href="${getPagePath($router, "gallery")}">Gallery</a>
          <a class="hover:underline" href="${getPagePath($router, "settings")}">Sync</a>
        </nav>
      </header>
      <main class="mx-auto max-w-5xl px-4 py-6">
        ${useStore($router, (page) => cache(routeView(page)))}
      </main>
    </div>
  `,
  renderRoot!,
);

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`<p class="text-zinc-400">Not found.</p>`;
  }
  return page.route === "gallery" ? cache(galleryView()) : cache(settingsView());
}
