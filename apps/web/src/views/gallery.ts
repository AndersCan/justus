import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { atom, computed } from "nanostores";
import { mediaEvents } from "@ekrooh/bare/plugins/media/events";
import type { FolderSummary, Photo, SyncStatus } from "@justus/core";
import { bus } from "../gateway";
import {
  $galleryError,
  $galleryState,
  $galleryViewModel,
  $lastSyncAt,
  gallery,
} from "../machines/gallery-machine";
import { $syncStatus } from "../machines/sync-machine";
import { $activeFolderId, $folders } from "../machines/folders-machine";
import { $requests } from "../machines/requests-machine";
import { useStore } from "../use-store";
import { formatRelative } from "../utils/time";
import { $photoSort } from "../utils/photo-sort";
import { workletBase } from "../utils/peer";
import { memberColor } from "../utils/palette";
import { $density, gridColsFor, type Density } from "../utils/gallery-density";
import {
  addTargets,
  albumCards,
  groupPhotos,
  photosInScope,
  sortPhotos,
  type AlbumCard,
  type PhotoScope,
  type PhotoSort,
} from "../utils/photo-scope";
import { errorBanner } from "./error-banner";
import { confirmAction } from "./confirm";
import { chooseAlbum } from "./choose-album";
import { toast } from "./toast";
import { waitingForAdmin } from "./invite";
import { openLightbox } from "./lightbox";
import { tabs } from "./tabs";

// "Add photos" posts the chosen file to the worklet's own `POST /photos`
// route (same-origin in the WebView, Vite-proxied in dev). In the native
// shell (Android/iOS WebView) the file input is dead — those hosts have no
// onShowFileChooser — so there we always use the host picker (`media.pick`),
// which the shell implements.
const fileInputRef = createRef<HTMLInputElement>();
const inNativeShell =
  typeof window !== "undefined" && (window as { BareShell?: boolean }).BareShell === true;
/** Web-only: a browser upload is in flight (it bypasses the gallery machine,
 * so `busy` doesn't cover it). Guards against double-pick and drives the
 * Add button's disabled state. */
const $webUploading = atom(false);
/** The album the next browser upload goes to; unset means the active album. */
let uploadTarget: string | undefined;

/** CSS <custom-ident> for the view-transition-name: unique per photo so the
 * grid reshuffles (Bramus-style) when photos are added/removed. */
const vtName = (photo: Photo) =>
  `photo-${`${photo.folderId ?? ""}-${photo.id}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** Where "Add photos" puts the photo: the album being viewed, the only album
 * that takes photos, or the one the user picks. Null when cancelled. */
async function resolveAddTarget(scope: PhotoScope): Promise<string | null> {
  if (scope.kind === "album") return scope.id;
  const targets = addTargets($folders.get());
  if (targets.length === 0) {
    toast("Create or join an album first");
    return null;
  }
  if (targets.length === 1) return targets[0].id;
  return chooseAlbum(targets, $activeFolderId.get());
}

async function pickAndAdd(scope: PhotoScope) {
  const folderId = await resolveAddTarget(scope);
  if (!folderId) return;
  if (inNativeShell) {
    const [err, result] = await bus.invoke(mediaEvents.media.pick("image"));
    // The host returns the original display name alongside the path, but the
    // framework's `MediaResult` type declares neither; read it structurally
    // so the picked photo keeps its real name in the native shell (#99).
    const picked = result as unknown as { path?: string; name?: string } | undefined;
    if (err || !picked?.path) {
      if (err?.message?.toLowerCase().includes("cancelled")) return;
      $galleryError.set("Couldn't open that photo — try another.");
      return;
    }
    gallery.add(picked.path, picked.name, folderId);
    return;
  }
  uploadTarget = folderId;
  fileInputRef.value?.click();
}

async function onFileChosen(file: File | null | undefined) {
  const folderId = uploadTarget;
  uploadTarget = undefined;
  if (!file || $webUploading.get()) return;
  $webUploading.set(true);
  try {
    const folder = folderId ? `&folder=${encodeURIComponent(folderId)}` : "";
    const response = await fetch(
      `${workletBase()}/photos?filename=${encodeURIComponent(file.name)}${folder}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    // The add pushes photos.changed — the gallery refreshes live.
    toast(`Added “${file.name}”`);
  } catch {
    $galleryError.set(`That photo didn't make it. Try again?`);
    toast("That photo didn't make it — try another");
  } finally {
    $webUploading.set(false);
  }
}

/** Everything the Photos page reads, as one plain value. */
const $photosPage = computed(
  [
    $galleryViewModel,
    $folders,
    $syncStatus,
    $lastSyncAt,
    $density,
    $photoSort,
    $webUploading,
    $requests,
  ],
  (gallery, folders, status, lastSync, density, sort, uploading, requests) => ({
    ...gallery,
    folders,
    status,
    lastSync,
    density,
    sort,
    uploading,
    requests,
  }),
);
type PhotosPage = ReturnType<typeof $photosPage.get>;

/** Empty-state illustration for the empty state. */
function emptyIllustration() {
  return html`<svg
    width="120"
    height="120"
    viewBox="0 0 120 120"
    fill="none"
    aria-hidden="true"
    class="mx-auto mb-4"
  >
    <rect x="26" y="18" width="68" height="84" rx="10" class="fill-surface stroke-line" />
    <rect x="34" y="26" width="52" height="44" rx="6" class="fill-subtle" />
    <circle cx="52" cy="40" r="7" class="fill-warn" />
    <path d="M34 64 L48 50 L60 62 L68 54 L86 70 L86 70 L34 70 Z" class="fill-accent" />
    <rect x="42" y="78" width="36" height="5" rx="2.5" class="fill-line" />
  </svg>`;
}

async function confirmRemove(photo: Photo) {
  if ($galleryState.get() === "removing") return;
  const ok = await confirmAction({
    title: `Remove “${photo.name}”?`,
    detail: "It will disappear from every device sharing this album.",
    confirmLabel: "Remove",
    tone: "danger",
  });
  if (!ok) return;
  gallery.remove(photo.id, photo.folderId);
  toast(`Removed “${photo.name}”`);
}

/** One grid tile. `within` is the grid it sits in (the lightbox steps through
 * it). */
function photoTile(photo: Photo, within: Photo[]) {
  return html`
    <figure
      class="group relative m-0 cursor-pointer overflow-hidden bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-inset"
      style="view-transition-name: ${vtName(photo)}"
      role="button"
      tabindex="0"
      aria-label="View ${photo.name}"
      @click=${() => openLightbox(photo, within)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openLightbox(photo, within);
        }
      }}
    >
      <img
        class="aspect-square w-full object-cover transition duration-200 group-hover:brightness-90"
        src="${photo.url}"
        alt="${photo.name}"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
      <button
        class="absolute right-1.5 top-1.5 hidden h-9 w-9 items-center justify-center rounded-full bg-black/60 text-sm text-white backdrop-blur-sm transition hover:bg-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [@media(hover:hover)]:flex [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
        title="Remove ${photo.name}"
        aria-label="Remove ${photo.name}"
        @click=${(e: Event) => {
          e.stopPropagation();
          void confirmRemove(photo);
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
    </figure>
  `;
}

/** Switch between the real timeline (date taken) and the Justus one (date
 * added). A radio group: it changes how the grid below is ordered. */
function sortControl(sort: PhotoSort) {
  const option = (value: PhotoSort, label: string) => {
    const on = sort === value;
    return html`<button
      class="ui-focus min-h-8 rounded-md px-3 text-xs font-medium transition ${
        on ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg"
      }"
      role="radio"
      aria-checked=${on ? "true" : "false"}
      @click=${() => $photoSort.set(value)}
    >
      ${label}
    </button>`;
  };
  return html`<div class="flex items-center justify-end gap-2">
    <span class="text-xs text-muted" id="photo-sort-label">Sort by</span>
    <div
      class="inline-flex gap-0.5 rounded-lg bg-subtle p-0.5"
      role="radiogroup"
      aria-labelledby="photo-sort-label"
    >
      ${option("added", "Date added")} ${option("taken", "Date taken")}
    </div>
  </div>`;
}

/** The timeline, newest first: by date added ("Recently added", then months)
 * or by date taken (months). */
function photoTimeline(photos: Photo[], sort: PhotoSort, density: Density) {
  const ordered = sortPhotos(photos, sort);
  return groupPhotos(ordered, sort).map(
    (group) => html`
      <div class="mt-6 first:mt-0">
        <h2 class="mb-2 flex items-baseline gap-2 text-sm font-semibold text-fg">
          <span>${group.label}</span>
          <span class="text-xs font-normal text-muted">${group.photos.length}</span>
        </h2>
        <div class="grid ${gridColsFor(density)} gap-0.5 overflow-hidden rounded-xl">
          ${group.photos.map((p) => photoTile(p, ordered))}
        </div>
      </div>
    `,
  );
}

function presenceStrip(status: SyncStatus, lastSync: number | null) {
  const online = status.peers > 0;
  const alone = status.members.length <= 1;
  const dotLabel = online ? "In sync" : alone ? "Ready to share" : "Waiting for devices";
  const dotPulse = online || alone ? "" : "animate-pulse motion-reduce:animate-none";
  const others = status.members.length - 1;
  return html`
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-warn"} ${dotPulse}"></span>
        ${dotLabel}
      </span>
      ${
        others > 0
          ? html`<span>shared with ${others} other${others === 1 ? "" : "s"}</span>`
          : html`<span>only you so far</span>`
      }
      ${lastSync ? html`<span class="text-xs">synced ${formatRelative(lastSync)}</span>` : null}
      <span class="flex items-center gap-1.5" aria-hidden="true">
        ${status.members.map(
          (m) => html`<span
            class="inline-block h-3 w-3 rounded-full ring-2 ring-white"
            style="background: ${memberColor(m.key)}"
            title="${m.name}"
          ></span>`,
        )}
      </span>
    </div>
  `;
}

function emptyState(title: string, body: string, actions: unknown) {
  return html`
    <div class="mt-4 rounded-3xl bg-surface px-6 py-10 text-center ring-1 ring-line">
      ${emptyIllustration()}
      <h2 class="text-xl font-semibold text-fg">${title}</h2>
      <p class="mx-auto mt-2 max-w-sm text-sm text-fg">${body}</p>
      <div class="mt-5 flex flex-wrap justify-center gap-2">${actions}</div>
    </div>
  `;
}

function addButton(page: PhotosPage, scope: PhotoScope, label = "Add photos") {
  return html`<button
    class="ui-btn-primary"
    ?disabled=${page.busy || page.state !== "ready" || page.uploading}
    @click=${() => void pickAndAdd(scope)}
  >
    ${(page.busy && page.state === "adding") || page.uploading ? "Adding…" : label}
  </button>`;
}

function scopeEmptyState(page: PhotosPage, scope: PhotoScope, album: FolderSummary | null) {
  const canAdd = addTargets(album ? [album] : page.folders).length > 0;
  const add = canAdd ? addButton(page, scope) : null;
  if (scope.kind === "album") {
    return emptyState(
      "No photos in this album yet.",
      canAdd
        ? "Add the first one. Everyone in the album gets it on their devices."
        : "Photos appear here as members add them and your device syncs.",
      add,
    );
  }
  if (scope.kind === "mine") {
    return emptyState(
      "You haven't added any photos yet.",
      "Photos you add to any album show up here.",
      add,
    );
  }
  if (page.folders.length === 0) {
    return emptyState(
      "No photos yet.",
      "Start an album for a trip, a family or a group, or join a friend's with their invite.",
      html`<a class="ui-btn-primary inline-flex items-center" href="/sharing">Start an album</a>
        <a class="ui-btn-ghost inline-flex items-center" href="/join">Join with invite</a>`,
    );
  }
  return emptyState(
    "No photos yet.",
    "Choose photos to keep here. They stay on your devices and sync only with the people in each album.",
    add,
  );
}

type PhotoTab = PhotoScope["kind"];

function photoTabs(active: PhotoTab) {
  return tabs(
    "Show photos",
    [
      { id: "all", label: "All", href: "/" },
      { id: "mine", label: "Added by me", href: "/mine" },
      { id: "album", label: "Albums", href: "/albums" },
    ],
    active,
  );
}

/** Title, actions and tabs. `scope` is where "Add photos" puts photos. */
function pageHeader(page: PhotosPage, scope: PhotoScope, active: PhotoTab = scope.kind) {
  return html`
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Photos</h1>
      <div class="flex shrink-0 gap-2">
        <input
          ${ref(fileInputRef)}
          type="file"
          accept="image/*"
          class="hidden"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            void onFileChosen(input.files?.[0]);
            input.value = "";
          }}
        />
        <button
          class="ui-btn-ghost"
          ?disabled=${page.busy || page.state === "loading" || page.fatal}
          @click=${() => gallery.load()}
        >
          Refresh
        </button>
        ${addButton(page, scope)}
      </div>
    </div>
    ${photoTabs(active)}
  `;
}

function albumHeader(page: PhotosPage, album: FolderSummary) {
  const status = page.status?.folder.id === album.id ? page.status : null;
  const waiting =
    album.role === "creator" ? page.requests.filter((r) => r.folderId === album.id).length : 0;
  return html`
    <div class="space-y-2">
      <a class="text-sm text-muted hover:text-fg" href="/albums">← All albums</a>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="min-w-0 truncate text-xl font-semibold tracking-tight text-fg">${album.name}</h2>
        <a
          class="ui-btn-ghost inline-flex shrink-0 items-center gap-1.5"
          href="/sharing/${album.id}"
        >
          Invite & members
          ${
            waiting > 0
              ? html`<span
                  class="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-4 text-white"
                  aria-label="${waiting} waiting for approval"
                  >${waiting}</span
                >`
              : null
          }
        </a>
      </div>
      ${status ? presenceStrip(status, page.lastSync) : null}
    </div>
  `;
}

function loadingGrid() {
  return html`<div class="grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
    ${Array.from(
      { length: 8 },
      () =>
        html`<div class="aspect-square animate-pulse bg-subtle motion-reduce:animate-none"></div>`,
    )}
  </div>`;
}

function photosBody(page: PhotosPage, scope: PhotoScope) {
  const { state, error, fatal } = page;
  const album =
    scope.kind === "album" ? (page.folders.find((f) => f.id === scope.id) ?? null) : null;
  const photos = photosInScope(page.photos, scope);
  const loading = (state === "loading" || state === "booting") && page.photos.length === 0;
  return html`
    <div class="space-y-5">
      ${pageHeader(page, scope)} ${waitingForAdmin()}
      ${
        scope.kind === "album"
          ? album
            ? albumHeader(page, album)
            : html`<a class="text-sm text-muted hover:text-fg" href="/albums">← All albums</a>
                <p class="text-muted">
                  ${page.folders.length === 0 ? "Loading…" : "This album isn't on this device."}
                </p>`
          : null
      }
      ${errorBanner(
        error,
        state === "error" && !fatal ? () => gallery.retry() : undefined,
        fatal ? () => window.location.reload() : undefined,
      )}
      ${
        loading
          ? loadingGrid()
          : scope.kind === "album" && !album
            ? null
            : photos.length === 0
              ? scopeEmptyState(page, scope, album)
              : html`
                  ${sortControl(page.sort)} ${photoTimeline(photos, page.sort, page.density)}
                  <footer class="pt-6 text-center text-xs text-muted">
                    ${photos.length} photo${photos.length === 1 ? "" : "s"}
                  </footer>
                `
      }
    </div>
  `;
}

/** The Photos page for one scope: every photo, only yours, or one album. */
export function galleryView(scope: PhotoScope) {
  return useStore($photosPage, (page) => photosBody(page, scope), true);
}

function albumCard(card: AlbumCard, waiting: number) {
  const { folder, cover, count } = card;
  return html`<li>
    <a
      class="ui-focus group block rounded-2xl"
      href="/albums/${folder.id}"
      aria-label="${folder.name}, ${count} photo${count === 1 ? "" : "s"}"
    >
      <div class="relative aspect-square overflow-hidden rounded-2xl bg-subtle ring-1 ring-line">
        ${
          cover
            ? html`<img
                class="h-full w-full object-cover transition duration-200 group-hover:brightness-90"
                src="${cover.url}"
                alt=""
                referrerpolicy="no-referrer"
                loading="lazy"
              />`
            : html`<div class="flex h-full items-center justify-center text-3xl text-muted">
                <span aria-hidden="true">＋</span>
              </div>`
        }
        ${
          waiting > 0
            ? html`<span
                class="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white"
                >${waiting} waiting</span
              >`
            : null
        }
      </div>
      <p class="mt-2 truncate text-sm font-medium text-fg">${folder.name}</p>
      <p class="truncate text-xs text-muted">
        ${count} photo${count === 1 ? "" : "s"}
        ${
          folder.pending
            ? html` · <span class="font-semibold text-warn">Waiting for the Admin</span>`
            : html` · ${folder.members} member${folder.members === 1 ? "" : "s"}`
        }
      </p>
    </a>
  </li>`;
}

function albumGridBody(page: PhotosPage) {
  const scope: PhotoScope = { kind: "all" };
  const cards = albumCards(page.folders, page.photos);
  return html`
    <div class="space-y-5">
      ${pageHeader(page, scope, "album")}
      ${
        cards.length === 0
          ? scopeEmptyState(page, scope, null)
          : html`<ul
              class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
              aria-label="Albums"
            >
              ${cards.map((card) =>
                albumCard(
                  card,
                  card.folder.role === "creator"
                    ? page.requests.filter((r) => r.folderId === card.folder.id).length
                    : 0,
                ),
              )}
              <li>
                <a
                  class="ui-focus flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-line text-sm text-muted hover:border-accent hover:text-accent"
                  href="/sharing"
                >
                  <span class="text-2xl" aria-hidden="true">＋</span>
                  New album
                </a>
              </li>
            </ul>`
      }
    </div>
  `;
}

/** Photos → Albums: one cover card per album; tap one to see its photos. */
export function albumGridView() {
  return useStore($photosPage, (page) => albumGridBody(page));
}
