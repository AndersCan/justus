import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";

/**
 * Which page is on screen. The URL is the source of truth; the machine holds
 * the parsed page so screens can `watch` it.
 */

export const ROUTES = {
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
} as const;

type ParamRoute = "photoAlbum" | "album";
type PlainRoute = Exclude<keyof typeof ROUTES, ParamRoute>;

export type AppPage =
  | { route: PlainRoute; params: Record<string, never> }
  | { route: ParamRoute; params: { id: string } };

function normalize(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.toLowerCase();
}

/** Matches a pathname (no search or hash) to a page; undefined when no route fits. */
export function parsePath(path: string): AppPage | undefined {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const lower = normalize(path);
  for (const [route, pattern] of Object.entries(ROUTES)) {
    const at = pattern.indexOf("/:");
    if (at === -1) {
      if (lower === pattern) return { route: route as PlainRoute, params: {} };
      continue;
    }
    const prefix = pattern.slice(0, at + 1);
    if (!lower.startsWith(prefix)) continue;
    const raw = clean.slice(prefix.length);
    if (raw === "" || raw.includes("/")) continue;
    try {
      return { route: route as ParamRoute, params: { id: decodeURIComponent(raw) } };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function pathFor(route: PlainRoute): string {
  return ROUTES[route];
}

type RouterContext = { page: AppPage | undefined };

/** The URL changed (a link, back/forward or `open`). */
const navigated = event("NAVIGATED")<{ page: AppPage | undefined }>();

/** The page in view. */
const showingPage = state("showingPage")();

export function createRouterActor(options: { clock: Clock; page: AppPage | undefined }) {
  return Actor({
    inputs: [navigated],
    internal: [],
    outputs: [],
    states: [showingPage],
    initial: showingPage,
    clock: options.clock,
    context: { page: options.page } as RouterContext,
    setup: (m) => {
      /** A new page replaces the old one; the machine stays where it is. */
      m.on(showingPage, {
        event: navigated,
        handler: (e, opts) => {
          opts.context.set({ page: e.payload.page });
          return {};
        },
      });
    },
  });
}

const hasWindow = typeof window !== "undefined";

export const routerActor = createRouterActor({
  clock: RealClock(),
  page: parsePath(hasWindow ? location.pathname : "/"),
});

export function currentPage(): AppPage | undefined {
  return routerActor.snapshot().context.page;
}

function sync(): void {
  routerActor.send(navigated.create({ page: parsePath(location.pathname) }));
}

/** Goes to `path`, adding a history entry (or replacing the current one). No-op on the current URL. */
export function open(path: string, o?: { replace?: boolean }): void {
  if (new URL(path, location.href).href === location.href) return;
  if (o?.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  sync();
}

/** Calls `fn` whenever the page changes. Not called on subscribe. */
export function onPageChange(
  fn: (page: AppPage | undefined, old: AppPage | undefined) => void,
): () => void {
  let last = currentPage();
  return routerActor.on("change", {
    fn: (s) => {
      const page = s.context.page;
      if (page === last) return;
      const old = last;
      last = page;
      fn(page, old);
    },
  });
}

function ownLink(e: MouseEvent): HTMLAnchorElement | undefined {
  if (e.defaultPrevented || e.button !== 0) return undefined;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return undefined;
  const link = (e.target as Element | null)?.closest?.("a");
  if (!link || !link.href) return undefined;
  const target = link.getAttribute("target");
  if (target && target !== "_self") return undefined;
  if (link.hasAttribute("download")) return undefined;
  if ((link.getAttribute("rel") ?? "").split(/\s+/).includes("external")) return undefined;
  if (new URL(link.href).origin !== location.origin) return undefined;
  return link;
}

if (hasWindow) {
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", sync);
  document.addEventListener("click", (e) => {
    const link = ownLink(e);
    if (!link) return;
    e.preventDefault();
    open(link.href);
  });
}
