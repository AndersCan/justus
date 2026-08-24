import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { atom, computed } from "nanostores";
import { mediaEvents } from "@ekrooh/bare/plugins/media/events";
import type { Photo } from "@justus/core";
import { bus } from "../gateway";
import {
  $galleryError,
  $galleryState,
  $galleryViewModel,
  $lastSyncAt,
  gallery,
} from "../machines/gallery-machine";
import { $syncStatus } from "../machines/sync-machine";
import { $activeFolderId, $folders, folders } from "../machines/folders-machine";
import { useStore } from "../use-store";
import { formatMonthGroup, formatRelative, sameMonth } from "../utils/time";
import { memberColor } from "../utils/palette";
import { gridColsFor, readDensity, writeDensity, type Density } from "../utils/gallery-density";
import { errorBanner } from "./error-banner";
import { confirmAction } from "./confirm";
import { toast } from "./toast";
import { openLightbox } from "./lightbox";

// "Pick photo" posts the chosen file to the worklet's own `POST /photos`
// route (same-origin in the WebView, Vite-proxied in dev). In the native
// shell (Android/iOS WebView) the file input is dead — those hosts have no
// onShowFileChooser — so there we always use the host picker (`media.pick`),
// which the shell implements.
const fileInputRef = createRef<HTMLInputElement>();
const inNativeShell =
  typeof window !== "undefined" && (window as { BareShell?: boolean }).BareShell === true;
/** Web-only: a browser upload is in flight (it bypasses the gallery machine,
 * so `busy` doesn't cover it). Guards against double-pick and drives the
 * Pick button's disabled state. */
const $webUploading = atom(false);

/** Gallery grid density — comfortable (default) or compact. Persisted. */
const $density = atom<Density>(readDensity());

/** CSS <custom-ident> for the view-transition-name: unique per photo so the
 * grid reshuffles (Bramus-style) when photos are added/removed. */
const vtName = (id: string) => `photo-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

async function pickAndAdd() {
  if (inNativeShell) {
    const [err, result] = await bus.invoke(mediaEvents.media.pick("image"));
    if (err || !result?.path) {
      if (err?.message?.toLowerCase().includes("cancelled")) return;
      $galleryError.set("Couldn't open that photo — try another.");
      return;
    }
    // The host returns the original display name alongside the path, but the
    // framework's `MediaResult` type predates that field; read it structurally
    // so the picked photo keeps its real name in the native shell (#99).
    const picked = result as { path: string; name?: string };
    gallery.add(picked.path, picked.name);
    return;
  }
  fileInputRef.value?.click();
}

async function onFileChosen(file: File | null | undefined) {
  if (!file || $webUploading.get()) return;
  $webUploading.set(true);
  try {
    const response = await fetch(`/photos?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
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

type GalleryViewModel = ReturnType<typeof $galleryViewModel.get>;

/** Warm polaroid illustration for the empty state. */
function emptyIllustration() {
  return html`<svg
    width="120"
    height="120"
    viewBox="0 0 120 120"
    fill="none"
    aria-hidden="true"
    class="mx-auto mb-4"
  >
    <rect x="26" y="18" width="68" height="84" rx="10" fill="#FFFDF6" stroke="#E2CEB2" />
    <rect x="34" y="26" width="52" height="44" rx="6" fill="#F3E4CC" />
    <circle cx="52" cy="40" r="7" fill="#C99A5B" />
    <path d="M34 64 L48 50 L60 62 L68 54 L86 70 L86 70 L34 70 Z" fill="#B05C2E" />
    <rect x="42" y="78" width="36" height="5" rx="2.5" fill="#E8D6BA" />
  </svg>`;
}

async function confirmRemove(photo: Photo) {
  if ($galleryState.get() === "removing") return;
  const ok = await confirmAction({
    title: `Remove “${photo.name}”?`,
    detail: "It will disappear from every device sharing this folder.",
    confirmLabel: "Remove",
    tone: "brick",
  });
  if (!ok) return;
  gallery.remove(photo.id);
  toast(`Removed “${photo.name}”`);
}

export function photoTile(photo: Photo) {
  return html`
    <figure
      class="group relative m-0 cursor-pointer overflow-hidden bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/60 focus-visible:ring-inset"
      style="view-transition-name: ${vtName(photo.id)}"
      role="button"
      tabindex="0"
      aria-label="View ${photo.name}"
      @click=${() => openLightbox(photo)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openLightbox(photo);
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
      <figcaption
        class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/90 via-ink/50 to-transparent px-3 pb-2.5 pt-8"
      >
        <div class="truncate font-serif text-sm italic text-linen">${photo.name}</div>
        <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#E9D3B5]">
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-full"
            style="background: ${memberColor(photo.member.key)}"
          ></span>
          <span class="truncate">${photo.member.name}</span>
          <span>·</span>
          <span>${formatRelative(photo.addedAt)}</span>
        </div>
      </figcaption>
      <button
        class="absolute right-2 top-2 flex h-11 min-h-11 w-11 items-center justify-center rounded-full bg-ink/60 text-sm text-linen backdrop-blur-sm transition hover:bg-brick focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linen/60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
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

/** Month-grouped photo tiles: "August 2026" serif rules between runs. */
function groupedPhotos(photos: Photo[], density: Density) {
  const groups: { label: string; photos: Photo[] }[] = [];
  for (const photo of photos) {
    const last = groups[groups.length - 1];
    if (last && sameMonth(photo.addedAt, last.photos[last.photos.length - 1].addedAt)) {
      last.photos.push(photo);
    } else {
      groups.push({ label: formatMonthGroup(photo.addedAt), photos: [photo] });
    }
  }
  return groups.map(
    (group) => html`
      <div class="mt-8 first:mt-0">
        <h2
          class="mb-3 flex items-baseline gap-2 border-b border-butter pb-2 font-serif text-lg text-cocoa"
        >
          <span>${group.label}</span>
          <span class="font-sans text-xs text-taupe">${group.photos.length}</span>
        </h2>
        <div class="grid ${gridColsFor(density)} gap-0">${group.photos.map(photoTile)}</div>
      </div>
    `,
  );
}

/** Toggle between the comfortable and compact gallery grids. */
function densityToggle() {
  return useStore($density, (density) => {
    const next: Density = density === "compact" ? "comfortable" : "compact";
    return html`<button
      class="warm-ghost"
      title="Toggle grid density"
      aria-label="Toggle gallery grid density (currently ${density})"
      @click=${() => {
        $density.set(next);
        writeDensity(next);
      }}
    >
      ${density === "compact" ? "Comfortable" : "Compact"}
    </button>`;
  });
}

function presenceStrip() {
  const status = $syncStatus.get();
  if (!status) {
    return html`<span class="text-sm text-taupe">Looking for your folder…</span>`;
  }
  const peers = status.peers;
  const known = status.members.length;
  const online = peers > 0;
  const alone = known <= 1;
  const dotColor = online ? "bg-moss" : alone ? "bg-caramel" : "bg-honey";
  const dotLabel = online ? "In sync" : alone ? "Ready to share" : "Waiting for devices";
  const dotPulse = online || alone ? "" : "animate-pulse motion-reduce:animate-none";
  const lastSync = $lastSyncAt.get();
  const otherCount = known > 1 ? known - 1 : 0;
  return html`
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-taupe">
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full ${dotColor} ${dotPulse}"></span>
        ${dotLabel}
      </span>
      <span>${status.photos} photo${status.photos === 1 ? "" : "s"}</span>
      ${
        otherCount > 0
          ? html`<span>shared with ${otherCount} other${otherCount === 1 ? "" : "s"}</span>`
          : null
      }
      ${lastSync ? html`<span class="text-xs">synced ${formatRelative(lastSync)}</span>` : null}
      <span class="flex items-center gap-1.5" aria-hidden="true">
        ${status.members.map(
          (m) => html`<span
            class="inline-block h-3 w-3 rounded-full ring-2 ring-linen"
            style="background: ${memberColor(m.key)}"
            title="${m.name}"
          ></span>`,
        )}
      </span>
    </div>
  `;
}

/** Active-folder anchor for the Gallery home view (G1): names the folder the
 * gallery is currently showing and offers an in-context switch when more than
 * one folder exists. Reads the same folder atoms the Folder tab uses; web-only. */
const $folderView = computed([$folders, $activeFolderId], (folders, activeId) => ({
  active: folders.find((f) => f.id === activeId) ?? null,
  all: folders,
}));

function folderContext() {
  return useStore($folderView, ({ active, all }) => {
    if (!active) {
      return html`<p class="text-sm text-taupe">No folder selected</p>`;
    }
    const others = all.filter((f) => f.id !== active.id);
    return html`
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-taupe">in</span>
        <span class="truncate font-serif text-xl text-cocoa" title=${active.name}
          >${active.name}</span
        >
        ${
          others.length > 0
            ? html`<label class="inline-flex items-center">
                <span class="sr-only">Switch folder</span>
                <select
                  class="warm-ghost cursor-pointer"
                  aria-label="Switch folder"
                  @change=${(e: Event) => {
                    const id = (e.target as HTMLSelectElement).value;
                    if (id) folders.switchTo(id);
                  }}
                >
                  ${all.map(
                    (f) =>
                      html`<option value=${f.id} ?selected=${f.id === active.id}>
                        ${f.name}
                      </option>`,
                  )}
                </select>
              </label>`
            : null
        }
      </div>
    `;
  });
}

function emptyState(view: GalleryViewModel) {
  const canAdd = view.role !== "reader";
  return html`
    <div class="mt-10 rounded-3xl bg-linen px-6 py-10 text-center ring-1 ring-line">
      ${emptyIllustration()}
      <h2 class="font-serif text-2xl text-ink">This folder is empty — for now.</h2>
      <p class="mx-auto mt-2 max-w-sm text-sm text-cocoa">
        ${
          canAdd
            ? "Add your first photo and it will appear on every device you share this folder with."
            : "Photos from this folder will appear here as your devices come online."
        }
      </p>
      <div class="mt-5 flex justify-center gap-2">
        ${
          canAdd
            ? html`<button class="warm-pill" @click=${() => void pickAndAdd()}>Add a photo</button>`
            : null
        }
        <a class="warm-ghost inline-flex items-center" href="/settings"
          >${view.role === "reader" ? "Join a folder" : "Set up another device"}</a
        >
      </div>
    </div>
  `;
}

function galleryBody(view: GalleryViewModel, density: Density) {
  const { state, busy, error, fatal, photos } = view;
  const readyEmpty = photos.length === 0 && state === "ready";
  return html`
    <div class="space-y-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="space-y-2">
          <h1 class="font-serif text-3xl text-ink">Gallery</h1>
          ${folderContext()} ${presenceStrip()}
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
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
            class="warm-ghost"
            ?disabled=${busy || state === "loading" || fatal}
            @click=${() => gallery.load()}
          >
            Check for new photos
          </button>
          ${useStore(
            $webUploading,
            (uploading) => html`<button
              class="warm-pill"
              ?disabled=${busy || state !== "ready" || uploading}
              @click=${() => void pickAndAdd()}
            >
              ${busy && state === "adding" ? "Adding…" : uploading ? "Adding…" : "Add a photo"}
            </button>`,
          )}
          ${densityToggle()}
        </div>
      </div>

      ${errorBanner(
        error,
        state === "error" && !fatal ? () => gallery.retry() : undefined,
        fatal ? () => window.location.reload() : undefined,
      )}
      ${
        state === "loading" && photos.length === 0
          ? html`<div class="grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              ${Array.from(
                { length: 8 },
                () =>
                  html`<div
                    class="aspect-square animate-pulse bg-butter motion-reduce:animate-none"
                  ></div>`,
              )}
            </div>`
          : null
      }
      ${
        readyEmpty
          ? emptyState(view)
          : html`
              ${groupedPhotos(photos, density)}
              <footer class="pt-8 text-center font-serif text-sm italic text-taupe">
                — ${photos.length} photo${photos.length === 1 ? "" : "s"} shared with care —
              </footer>
            `
      }
    </div>
  `;
}

export function galleryView() {
  return useStore(
    $galleryViewModel,
    (vm) => useStore($density, (density) => galleryBody(vm, density)),
    true,
  );
}
