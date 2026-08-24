import { html, render } from "lit-html";
import { cache } from "lit-html/directives/cache.js";
import { getPagePath } from "@nanostores/router";
import "uno.css";
import { messenger, transport } from "./gateway";
import { handleMessage } from "./handle-message";
import { folders } from "./machines/folders-machine";
import { gallery } from "./machines/gallery-machine";
import { requests } from "./machines/requests-machine";
import { sync } from "./machines/sync-machine";
import { $router, type AppPage } from "./router";
import { useStore } from "./use-store";
import { galleryView } from "./views/gallery";
import { albumsView } from "./views/albums";
import { lightboxView } from "./views/lightbox";
import { requestsView } from "./views/requests";
import { settingsView } from "./views/settings";
import { connectionIndicator } from "./views/connection";

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
folders.refresh();
requests.refresh();

// Small shared animations for confirm sheets and toasts (respects reduced
// motion). Injected once; lit-html only plays them on element insert.
const motionStyle = document.createElement("style");
motionStyle.textContent = `
  @keyframes justus-rise { from { opacity: 0; transform: translateY(14px) scale(.98); } }
  @keyframes justus-fade { from { opacity: 0; } }
  .justus-backdrop { animation: justus-fade 180ms ease-out; }
  .justus-sheet { animation: justus-rise 260ms cubic-bezier(.22,1,.36,1); }
  .justus-toast { animation: justus-rise 240ms cubic-bezier(.22,1,.36,1); }
  @media (prefers-reduced-motion: reduce) {
    .justus-backdrop, .justus-sheet, .justus-toast { animation: none; }
  }
`;
document.head.appendChild(motionStyle);

const renderRoot = document.getElementById("render-root");
render(
  html`
    <div class="min-h-screen bg-paper pb-[max(1.5rem,env(safe-area-inset-bottom))] text-cocoa">
      <header class="border-b border-line bg-linen">
        <nav
          class="mx-auto flex max-w-6xl items-center gap-6 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-sm sm:px-6"
          aria-label="Main"
        >
          <span class="font-serif text-xl font-bold tracking-tight text-clay">Justus</span>
          <span class="ml-auto">${connectionIndicator()}</span>
          ${useStore($router, (page) => {
            const link = (name: "gallery" | "albums" | "settings" | "requests", label: string) => {
              const active = page?.route === name;
              return html`<a
                class="decoration-line underline-offset-4 hover:text-clay hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/30 ${
                  active ? "font-semibold text-clay" : "text-cocoa"
                }"
                href="${getPagePath($router, name)}"
                aria-current=${active ? "page" : undefined}
                >${label}</a
              >`;
            };
            return html`${link("gallery", "Gallery")} ${link("albums", "Albums")}
            ${link("settings", "Folder")} ${link("requests", "Requests")}`;
          })}
        </nav>
      </header>
      <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        ${useStore($router, (page) => cache(routeView(page)))}
      </main>
    </div>
    ${lightboxView()}
  `,
  renderRoot!,
);

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`<p class="text-taupe">We couldn't find that page.</p>`;
  }
  if (page.route === "gallery") return galleryView();
  if (page.route === "albums") return albumsView();
  if (page.route === "requests") return requestsView();
  return settingsView();
}
