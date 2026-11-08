import { html, render } from "lit-html";
import { cache } from "lit-html/directives/cache.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
import { watch } from "@mantaq/lit";
import "uno.css";
import { transport } from "./gateway";
import { handleMessage } from "./handle-message";
import { folders } from "./machines/folders-machine";
import { gallery } from "./machines/gallery-machine";
import { requests, requestsActor } from "./machines/requests-machine";
import { syncActor, sync } from "./machines/sync-machine";
import { updateBanner, updateLines } from "./views/notices";
import { open, pathFor, routerActor, type AppPage } from "./machines/router-machine";
import { albumGridView, galleryView } from "./views/gallery";
import { lightboxView } from "./views/lightbox";
import { albumView } from "./views/album";
import { sharingView } from "./views/sharing";
import { settingsView } from "./views/settings";
import { helpView } from "./views/help";
import { reachActor, reachHintOf } from "./machines/reach-hint-machine";
import { welcomeView, hasSeenWelcome, readLockForOnboarding } from "./views/welcome";
import { joinSheet, listenForHostInvites } from "./views/invite";
import { startWebLogCapture } from "./log-capture";
import { wordmark } from "./views/wordmark";

import { copy, t } from "./copy/copy";
// The Android/iOS shells serve the app from a path ending in index.html —
// normalize to the gallery route so first load never lands on "Not found".
if (window.location.pathname.endsWith("/index.html")) {
  open("/", { replace: true });
}

// First run: show the "no servers" welcome screen once per install.
if (!hasSeenWelcome()) {
  open("/welcome", { replace: true });
  void readLockForOnboarding();
}

// Capture web-layer diagnostics (console + page errors) into the shared log
// timeline. Skips itself on the mock transport; on unload we drain the last
// sub-interval batch so it isn't lost (issue #14).
const webLogCapture = startWebLogCapture();
if (webLogCapture) {
  window.addEventListener("pagehide", () => webLogCapture.flush());
}

transport.subscribe((message) => {
  handleMessage(message);
});

listenForHostInvites();
gallery.load();
sync.refresh();
folders.refresh();
requests.refresh();

// Small shared animations for confirm sheets, toasts and new log lines (respects reduced
// motion). Injected once; lit-html only plays them on element insert.
const motionStyle = document.createElement("style");
motionStyle.textContent = `
  @keyframes justus-rise { from { opacity: 0; transform: translateY(14px) scale(.98); } }
  @keyframes justus-fade { from { opacity: 0; } }
  .justus-backdrop { animation: justus-fade 180ms ease-out; }
  .justus-sheet { animation: justus-rise 260ms cubic-bezier(.22,1,.36,1); }
  .justus-toast { animation: justus-rise 240ms cubic-bezier(.22,1,.36,1); }
  .justus-log-line { animation: justus-fade 200ms ease-out; }
  .justus-holders-text { animation: justus-fade 180ms ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .justus-backdrop, .justus-sheet, .justus-toast, .justus-log-line, .justus-holders-text { animation: none; }
  }
`;
document.head.appendChild(motionStyle);

const renderRoot = document.getElementById("render-root");

type NavRoute = "gallery" | "sharing" | "settings";

/** Sub-pages that light up their section's nav item. */
const NAV_SECTION: Partial<Record<AppPage["route"], NavRoute>> = {
  mine: "gallery",
  photoAlbums: "gallery",
  photoAlbum: "gallery",
  sharingJoin: "sharing",
  sharingDevices: "sharing",
  album: "sharing",
  help: "settings",
};

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
    label: copy("app.photos"),
    paths:
      '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-5-5L5 21"/>',
  },
  {
    route: "sharing",
    label: copy("app.sharing"),
    paths:
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.8 3 2.7 3 5.6"/>',
  },
  {
    route: "settings",
    label: copy("app.settings"),
    paths:
      '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  },
];

function navLink(
  page: AppPage | undefined,
  item: (typeof NAV)[number],
  layout: "rail" | "tab",
  waiting: number,
) {
  const section = page ? (NAV_SECTION[page.route] ?? page.route) : undefined;
  const active = section === item.route;
  const badge = item.route === "sharing" && waiting > 0 ? waiting : 0;
  const base =
    layout === "rail"
      ? "ui-focus flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
      : "ui-focus flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition";
  const tone = active
    ? layout === "rail"
      ? "bg-accent-soft text-accent"
      : "text-accent"
    : layout === "rail"
      ? "text-muted hover:bg-subtle hover:text-fg"
      : "text-muted";
  return html`<a
    class="${base} ${tone}"
    href="${pathFor(item.route)}"
    aria-current=${active ? "page" : undefined}
    ><span class="relative inline-flex"
      >${icon(item.paths)}${
        badge
          ? html`<span
              class="absolute -right-2 -top-1 rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-on-fill"
              aria-label=${copy("app.waiting_for_approval", { badge })}
              >${badge}</span
            >`
          : null
      }</span
    ><span>${item.label}</span></a
  >`;
}

function navLinks(layout: "rail" | "tab") {
  return watch(routerActor, (r) =>
    watch(requestsActor, (q) =>
      NAV.map((item) => navLink(r.context.page, item, layout, q.context.requests.length)),
    ),
  );
}

render(
  html`
    <div class="min-h-screen bg-canvas text-fg md:pl-60">
      <aside
        class="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-surface px-3 py-5 md:flex"
      >
        <span class="px-3 pb-5">${wordmark("h-8 w-auto")}</span>
        <nav class="flex flex-col gap-1" aria-label=${copy("app.main")}>${navLinks("rail")}</nav>
      </aside>
      <!-- No mobile app bar: the bottom tabs carry navigation. This strip only
           keeps scrolled content out from under the status bar. -->
      <div
        class="fixed inset-x-0 top-0 z-10 h-[env(safe-area-inset-top)] bg-canvas md:hidden"
        aria-hidden="true"
      ></div>
      <main
        class="mx-auto max-w-6xl px-4 pb-28 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-6 md:pb-10 md:pt-6"
      >
        ${watch(syncActor, (s) => updateBanner(updateLines(s.context.status)))}
        ${watch(reachActor, (s) => {
          const hint = reachHintOf(s);
          return hint
            ? html`<p
                class="mb-4 rounded-xl bg-subtle px-4 py-2.5 text-sm text-fg ring-1 ring-trust-amber/40"
                role="status"
              >
                ${hint} <a class="underline" href="${pathFor("help")}">${t("app.more_help")}</a>
              </p>`
            : null;
        })}
        ${watch(routerActor, (s) => cache(routeView(s.context.page)))}
      </main>
      <nav
        class="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label=${copy("app.main")}
      >
        ${navLinks("tab")}
      </nav>
    </div>
    ${lightboxView()} ${joinSheet()}
  `,
  renderRoot!,
);

function routeView(page: AppPage | undefined) {
  if (!page) {
    return html`<p class="text-muted">${t("app.we_couldn_t_find_that")}</p>`;
  }
  if (page.route === "gallery") return galleryView({ kind: "all" });
  if (page.route === "mine") return galleryView({ kind: "mine" });
  if (page.route === "photoAlbums") return albumGridView();
  if (page.route === "photoAlbum") return galleryView({ kind: "album", id: page.params.id });
  if (page.route === "album") return albumView(page.params.id);
  if (page.route === "sharing") return sharingView("albums");
  if (page.route === "sharingJoin") return sharingView("join");
  if (page.route === "sharingDevices") return sharingView("devices");
  if (page.route === "help") return helpView();
  if (page.route === "welcome") return welcomeView();
  return settingsView();
}
