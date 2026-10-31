import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { atom, computed } from "nanostores";
import type { FolderSummary, Photo, SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import {
  $addBatch,
  $galleryState,
  $galleryViewModel,
  $lastSyncAt,
  gallery,
  sourceName,
  type AddBatch,
  type AddSource,
} from "../machines/gallery-machine";
import { $syncStatus } from "../machines/sync-machine";
import { $activeFolderId, $folders } from "../machines/folders-machine";
import { $requests } from "../machines/requests-machine";
import { useStore } from "../use-store";
import { formatRelative } from "../utils/time";
import { $photoSort } from "../utils/photo-sort";
import { $router } from "../router";
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
import { startAlbum } from "./start-album";
import {
  batchSummary,
  imageFiles,
  lastAddAlbum,
  planAdd,
  rememberAddAlbum,
  type AddPlan,
} from "../utils/add-photos";
import { toast } from "./toast";
import { waitingForAdmin } from "./invite";
import { openLightbox } from "./lightbox";
import { tabs } from "./tabs";

// Adding photos: work out where they can go (before any picker opens, so a
// dead end never costs a pick), pick one or many, ask which album only when
// several could take them, then hand the batch to the gallery actor, which
// adds them one by one with progress in `$addBatch`.
//
// In the native shell (Android/iOS WebView) the file input is dead (those
// hosts have no onShowFileChooser), so the host picks (`justus.media`) and
// stages the files where the worklet can import them. In a browser the
// chosen files are posted to the worklet's `POST /photos` route.
const fileInputRef = createRef<HTMLInputElement>();
const inNativeShell =
  typeof window !== "undefined" && (window as { BareShell?: boolean }).BareShell === true;
/** The plan the browser file picker was opened with (it may have started an
 * album first); a change without one (e.g. e2e) plans from the page. */
let webPlan: AddPlan | null = null;
/** Photos are being dragged over the page (browser/desktop only). */
const $dropActive = atom(false);
/** How the running batch was picked, for the "Take another" follow-up. */
let batchVia: "library" | "camera" = "library";

/** CSS <custom-ident> for the view-transition-name: unique per photo so the
 * grid reshuffles (Bramus-style) when photos are added/removed. */
const vtName = (photo: Photo) =>
  `photo-${`${photo.folderId ?? ""}-${photo.id}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

const albumName = (folderId?: string) =>
  $folders.get().find((f) => f.id === folderId)?.name ?? "the album";

/** Resolves where photos can go from `scope`, starting an album first when
 * there is none. Null when there is nowhere (and the user has been told). */
async function readyPlan(scope: PhotoScope): Promise<AddPlan | null> {
  const plan = planAdd(scope, $folders.get());
  if (plan.kind === "none" || plan.kind === "viewer") {
    const detail =
      plan.kind === "none"
        ? "Photos live in albums. Name your first one; you can invite people later."
        : plan.album
          ? `You can view “${plan.album.name}” but not add to it. Start your own album for your photos.`
          : "You can view your albums but not add to them. Start your own album for your photos.";
    const id = await startAlbum(detail);
    if (!id) return null;
    $router.open(`/albums/${id}`);
    return { kind: "direct", folderId: id };
  }
  if (plan.kind === "pending") {
    toast(`“${plan.album.name}” is waiting for the Admin to let you in`);
    return null;
  }
  return plan;
}

/** Picked photos → the album they go to → the gallery actor's batch. */
async function addPicked(plan: AddPlan, sources: AddSource[], via: "library" | "camera") {
  if (sources.length === 0) return;
  if ($addBatch.get()?.running) {
    toast("Still adding the last photos. Try again in a moment");
    return;
  }
  let folderId: string | null = null;
  if (plan.kind === "direct") folderId = plan.folderId;
  else if (plan.kind === "choose") {
    folderId = await chooseAlbum(
      plan.albums,
      lastAddAlbum() ?? $activeFolderId.get(),
      sources.length,
    );
  }
  if (!folderId) return;
  rememberAddAlbum(folderId);
  batchVia = via;
  gallery.addMany(sources, folderId);
}

const cancelled = (err: unknown) =>
  err instanceof Error && err.message.toLowerCase().includes("cancelled");

/** The native picker (many at once) or camera; null when cancelled. */
async function pickNative(via: "library" | "camera"): Promise<AddSource[] | null> {
  if (via === "camera") {
    const [err, shot] = await gateway.media.capture();
    if (err || !shot?.path) {
      if (!cancelled(err)) toast("Couldn't use the camera. Try again?");
      return null;
    }
    return [{ kind: "path", path: shot.path, name: shot.name }];
  }
  const [err, result] = await gateway.media.pickMany();
  if (err || !result?.items?.length) {
    if (!cancelled(err)) toast("Couldn't open your photos. Try again?");
    return null;
  }
  return result.items.map((item) => ({ kind: "path", path: item.path, name: item.name }));
}

async function startAdd(scope: PhotoScope, via: "library" | "camera" = "library") {
  const plan = await readyPlan(scope);
  if (!plan) return;
  if (inNativeShell) {
    const sources = await pickNative(via);
    if (sources) await addPicked(plan, sources, via);
    return;
  }
  webPlan = plan;
  fileInputRef.value?.click();
}

function onFilesChosen(scope: PhotoScope, files: FileList | null) {
  const plan = webPlan ?? planAdd(scope, $folders.get());
  webPlan = null;
  const sources = imageFiles(files).map((file): AddSource => ({ kind: "file", file }));
  void addPicked(plan, sources, "library");
}

/** Drag-and-drop and paste (browser/desktop): same batch path as the picker. */
async function addDropped(scope: PhotoScope, files: FileList | File[] | null | undefined) {
  const images = imageFiles(files);
  if (images.length === 0) {
    toast("Only photos can be added");
    return;
  }
  const plan = await readyPlan(scope);
  if (!plan) return;
  await addPicked(
    plan,
    images.map((file) => ({ kind: "file", file })),
    "library",
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
let dragDepth = 0;
function dropHandlers(scope: PhotoScope) {
  if (inNativeShell) return { enter: null, over: null, leave: null, drop: null };
  return {
    enter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      $dropActive.set(true);
    },
    over: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    leave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) $dropActive.set(false);
    },
    drop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $dropActive.set(false);
      void addDropped(scope, e.dataTransfer?.files);
    },
  };
}

/** The Photos page in view, as an add scope (null elsewhere). */
function routeScope(): PhotoScope | null {
  const page = $router.get();
  if (!page) return null;
  if (page.route === "gallery" || page.route === "photoAlbums") return { kind: "all" };
  if (page.route === "mine") return { kind: "mine" };
  if (page.route === "photoAlbum") return { kind: "album", id: page.params.id };
  return null;
}

// Paste a copied image on a Photos page to add it.
if (typeof document !== "undefined" && !inNativeShell) {
  document.addEventListener("paste", (e) => {
    const scope = routeScope();
    const target = e.target as HTMLElement | null;
    if (!scope || target?.closest("input, textarea, [contenteditable]")) return;
    const files = imageFiles(e.clipboardData?.files);
    if (files.length === 0) return;
    e.preventDefault();
    void addDropped(scope, files);
  });
}

// When a batch ends cleanly, say what happened and clear it; one with
// failures stays on the page (with Retry) until dismissed.
$addBatch.listen((batch, previous) => {
  if (!previous?.running || !batch || batch.running) return;
  if (batch.failed.length > 0) return;
  const camera = batchVia === "camera";
  const scope = routeScope();
  toast(
    batchSummary(batch, albumName(batch.folderId)),
    camera && scope && batch.folderId
      ? {
          action: {
            label: "Take another",
            run: () => void startAdd({ kind: "album", id: batch.folderId as string }, "camera"),
          },
        }
      : {},
  );
  gallery.dismissBatch();
});

/** Everything the Photos page reads, as one plain value. */
const $photosPage = computed(
  [
    $galleryViewModel,
    $folders,
    $syncStatus,
    $lastSyncAt,
    $density,
    $photoSort,
    $addBatch,
    $dropActive,
    $requests,
  ],
  (gallery, folders, status, lastSync, density, sort, batch, dropActive, requests) => ({
    ...gallery,
    folders,
    status,
    lastSync,
    density,
    sort,
    batch,
    dropActive,
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
  const running = page.batch?.running ?? false;
  return html`<button
    class="ui-btn-primary"
    ?disabled=${page.busy || page.state !== "ready" || running}
    @click=${() => void startAdd(scope)}
  >
    ${running && page.batch ? `Adding ${page.batch.done + 1}/${page.batch.total}…` : label}
  </button>`;
}

/** Native shell only: snap a photo straight into the album. */
function cameraButton(page: PhotosPage, scope: PhotoScope) {
  if (!inNativeShell) return null;
  return html`<button
    class="ui-btn-ghost inline-flex items-center"
    aria-label="Take photo"
    title="Take photo"
    ?disabled=${page.busy || page.state !== "ready" || (page.batch?.running ?? false)}
    @click=${() => void startAdd(scope, "camera")}
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"
      />
      <circle cx="12" cy="13" r="3" />
    </svg>
  </button>`;
}

/** Progress of an add batch, then its failures (with Retry) if any. */
function batchStrip(batch: AddBatch | null) {
  if (!batch) return null;
  const album = albumName(batch.folderId);
  if (batch.running) {
    const shown = Math.min(batch.done + 1, batch.total);
    return html`<div class="rounded-2xl bg-surface p-4 ring-1 ring-line" role="status">
      <p class="text-sm text-fg">
        Adding ${batch.total === 1 ? "a photo" : `${shown} of ${batch.total}`} to
        <span class="font-medium">${album}</span>…
      </p>
      <div
        class="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle"
        role="progressbar"
        aria-label="Adding photos"
        aria-valuemin="0"
        aria-valuemax=${batch.total}
        aria-valuenow=${batch.done}
      >
        <div
          class="h-full rounded-full bg-accent transition-all duration-300"
          style="width: ${Math.round((batch.done / batch.total) * 100)}%"
        ></div>
      </div>
    </div>`;
  }
  if (batch.failed.length === 0) return null;
  const names = batch.failed.map((f) => sourceName(f.source)).filter(Boolean);
  return html`<div
    class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface p-4 ring-1 ring-danger/40"
    role="alert"
  >
    <div class="min-w-0">
      <p class="text-sm font-medium text-fg">${batchSummary(batch, album)}</p>
      ${
        names.length
          ? html`<p class="mt-0.5 truncate text-xs text-muted">${names.join(", ")}</p>`
          : null
      }
    </div>
    <div class="flex shrink-0 gap-2">
      <button class="ui-btn-ghost" @click=${() => gallery.dismissBatch()}>Dismiss</button>
      <button class="ui-btn-primary" @click=${() => gallery.retryFailed()}>Retry</button>
    </div>
  </div>`;
}

/** Shown over the page while photos are dragged onto it. */
function dropOverlay(page: PhotosPage, scope: PhotoScope) {
  if (!page.dropActive) return null;
  const plan = planAdd(scope, page.folders);
  const where = plan.kind === "direct" ? ` to ${albumName(plan.folderId)}` : "";
  return html`<div
    class="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 p-6"
  >
    <div
      class="rounded-3xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center text-fg shadow-xl"
    >
      <p class="text-lg font-semibold">Drop to add${where}</p>
      <p class="mt-1 text-sm text-muted">Photos stay on your devices and the album's.</p>
    </div>
  </div>`;
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
          multiple
          class="hidden"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            onFilesChosen(scope, input.files);
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
        ${cameraButton(page, scope)} ${addButton(page, scope)}
      </div>
    </div>
    ${photoTabs(active)} ${batchStrip(page.batch)}
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
  const drop = dropHandlers(scope);
  return html`
    <div
      class="space-y-5"
      @dragenter=${drop.enter}
      @dragover=${drop.over}
      @dragleave=${drop.leave}
      @drop=${drop.drop}
    >
      ${dropOverlay(page, scope)} ${pageHeader(page, scope)} ${waitingForAdmin()}
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
  const drop = dropHandlers(scope);
  return html`
    <div
      class="space-y-5"
      @dragenter=${drop.enter}
      @dragover=${drop.over}
      @dragleave=${drop.leave}
      @drop=${drop.drop}
    >
      ${dropOverlay(page, scope)} ${pageHeader(page, scope, "album")}
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
