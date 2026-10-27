import { html, render } from "lit-html";
import { cache } from "lit-html/directives/cache.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
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
import { lightboxView } from "./views/lightbox";
import { albumsView } from "./views/albums";
import { sharingView } from "./views/sharing";
import { settingsView } from "./views/settings";
import { helpView } from "./views/help";
import { $reachHint } from "./machines/reach-hint-machine";
import { connectionIndicator } from "./views/connection";
import { peopleChip, peopleSheet } from "./views/people";
import { themeToggle } from "./views/theme-toggle";
import { welcomeView, hasSeenWelcome } from "./views/welcome";
import { inviteConsentSheet, listenForHostInvites } from "./views/invite";
import { startWebLogCapture } from "./log-capture";

// The Android/iOS shells serve the app from a path ending in index.html —
// normalize to the gallery route so first load never lands on "Not found".
if (window.location.pathname.endsWith("/index.html")) {
  $router.open("/", true);
}

// First run: show the "no servers" welcome screen once per install.
if (!hasSeenWelcome()) {
  $router.open("/welcome", true);
}

// Capture web-layer diagnostics (console + page errors) into the shared log
// timeline. Skips itself on the mock transport; on unload we drain the last
// sub-interval batch so it isn't lost (issue #14).
const webLogCapture = startWebLogCapture();
if (webLogCapture) {
  window.addEventListener("pagehide", () => webLogCapture.flush());
}

transport.subscribe((message) => {
  messenger.handleIncoming(message.header);
  handleMessage(message);
});

listenForHostInvites();
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

type NavRoute = "gallery" | "albums" | "sharing" | "help" | "settings";

const icon = (paths: string) =>
  html`<svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${unsafeSVG(paths)}
  </svg>`;

const NAV: { route: NavRoute; label: string; paths: string }[] = [
  {
    route: "gallery",
    label: "Photos",
    paths:
      '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-5-5L5 21"/>',
  },
  {
    route: "albums",
    label: "Albums",
    paths:
      '<rect x="7" y="7" width="14" height="14" rx="2.5"/><path d="M17 3H6a3 3 0 0 0-3 3v11"/><path d="m21 17-4-4-6 6"/>',
  },
  {
    route: "sharing",
    label: "Sharing",
    paths:
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.8 3 2.7 3 5.6"/>',
  },
  {
    route: "help",
    label: "Help",
    paths:
      '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.2-2.5 3.8M12 17.2h.01"/>',
  },
];

function navLink(page: AppPage | undefined, item: (typeof NAV)[number], layout: "rail" | "tab") {
  const active =
    page?.route === item.route || (item.route === "sharing" && page?.route === "settings");
  const base =
    layout === "rail"
      ? "ui-focus flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
      : "ui-focus flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition";
  const tone = active
    ? layout === "rail"
      ? "bg-accent/10 text-accent"
      : "text-accent"
    : layout === "rail"
      ? "text-muted hover:bg-subtle hover:text-fg"
      : "text-muted";
  return html`<a
    class="${base} ${tone}"
    href="${getPagePath($router, item.route)}"
    aria-current=${active ? "page" : undefined}
    >${icon(item.paths)}<span>${item.label}</span></a
  >`;
}

render(
  html`
    <div class="min-h-screen bg-canvas text-fg md:pl-60">
      <aside
        class="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-surface px-3 py-5 md:flex"
      >
        <span class="px-3 pb-5 text-lg font-semibold tracking-tight">Justus</span>
        <nav class="flex flex-col gap-1" aria-label="Main">
          ${useStore($router, (page) => NAV.map((item) => navLink(page, item, "rail")))}
        </nav>
        <div class="mt-auto flex items-center justify-between gap-2 px-3">
          ${peopleChip()} ${connectionIndicator()} ${themeToggle()}
        </div>
      </aside>
      <header
        class="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/90 px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur md:hidden"
      >
        <span class="text-base font-semibold tracking-tight">Justus</span>
        <span class="flex items-center gap-3"
          >${peopleChip()} ${connectionIndicator()} ${themeToggle()}</span
        >
      </header>
      <main class="mx-auto max-w-6xl px-4 py-6 pb-28 sm:px-6 md:pb-10">
        ${useStore($reachHint, (hint) =>
          hint
            ? html`<p
                class="mb-4 rounded-xl bg-subtle px-4 py-2.5 text-sm text-fg ring-1 ring-trust-amber/40"
                role="status"
              >
                ${hint} <a class="underline" href="${getPagePath($router, "help")}">More help</a>
              </p>`
            : null,
        )}
        ${useStore($router, (page) => cache(routeView(page)))}
      </main>
      <nav
        class="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Main"
      >
        ${useStore($router, (page) => NAV.map((item) => navLink(page, item, "tab")))}
      </nav>
    </div>
    ${lightboxView()} ${peopleSheet()} ${inviteConsentSheet()}
  `,
  renderRoot!,
);

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`<p class="text-muted">We couldn't find that page.</p>`;
  }
  if (page.route === "gallery") return galleryView();
  if (page.route === "albums") return albumsView();
  if (page.route === "sharing") return sharingView();
  if (page.route === "help") return helpView();
  if (page.route === "welcome") return welcomeView();
  return settingsView();
}
