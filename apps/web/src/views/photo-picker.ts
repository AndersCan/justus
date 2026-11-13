import { html } from "lit-html";
import { createRef, ref } from "lit-html/directives/ref.js";
import { gateway } from "../gateway";
import { foldersActor } from "../machines/folders-machine";
import { gallery, galleryActor, type AddSource } from "../machines/gallery-machine";
import { syncActor } from "../machines/sync-machine";
import { imageFiles, planAdd } from "../utils/add-photos";
import { ownerShown } from "../utils/invite-link";
import { knownAdminName } from "./invite";
import { copy } from "../copy/copy";
import { toast } from "./toast";

// Adding photos: check the album can take them (before any picker opens, so a
// dead end never costs a pick), pick one or many, then hand the batch to the
// gallery actor, which adds them one by one with progress.
//
// In the native shell (Android/iOS WebView) the file input is dead (those
// hosts have no onShowFileChooser), so the host picks (`justus.media`) and
// stages the files where the worklet can import them. In a browser the
// chosen files are posted to the worklet's `POST /photos` route.
const fileInputRef = createRef<HTMLInputElement>();
export function inNativeShell(): boolean {
  return typeof window !== "undefined" && (window as { BareShell?: boolean }).BareShell === true;
}
/** How the running batch was picked, for the "Take another" follow-up. */
let batchVia: "library" | "camera" = "library";

export const pickedVia = () => batchVia;

const foldersNow = () => foldersActor.snapshot().context.folders;

/** The album, if photos can go into it; otherwise tells the user why not. */
export function addableAlbum(folderId: string): string | null {
  const plan = planAdd(folderId, foldersNow(), syncActor.snapshot().context.status);
  if (plan.kind === "unknown") {
    toast(copy("gallery.getting_your_access"));
    return null;
  }
  if (plan.kind === "viewer") {
    toast(copy("gallery.you_can_view_but_not", { name: plan.album.name }));
    return null;
  }
  if (plan.kind === "pending") {
    const status = syncActor.snapshot().context.status;
    const admin = status?.folder.id === folderId ? knownAdminName(status) : "";
    toast(
      copy("gallery.you_can_add_photos_to", {
        name: plan.album.name,
        owner: ownerShown(admin, "mid"),
      }),
    );
    return null;
  }
  return plan.folderId;
}

/** Picked photos → the gallery actor's batch for the album on screen. */
export function addPicked(
  folderId: string,
  sources: AddSource[],
  via: "library" | "camera",
): boolean {
  if (sources.length === 0) return false;
  if (galleryActor.snapshot().context.batch?.running) {
    toast(copy("gallery.still_adding_the_last_photos"));
    return false;
  }
  batchVia = via;
  gallery.addMany(sources, folderId);
  return true;
}

const cancelled = (err: unknown) =>
  err instanceof Error && err.message.toLowerCase().includes("cancelled");

/** The native picker (many at once) or camera; null when cancelled. */
async function pickNative(via: "library" | "camera"): Promise<AddSource[] | null> {
  if (via === "camera") {
    const [err, shot] = await gateway.media.capture();
    if (err || !shot?.path) {
      if (!cancelled(err)) toast(copy("gallery.couldn_t_use_the_camera"));
      return null;
    }
    return [{ kind: "path", ...shot }];
  }
  const [err, result] = await gateway.media.pickMany();
  if (err || !result?.items?.length) {
    if (!cancelled(err)) toast(copy("gallery.couldn_t_open_your_photos"));
    return null;
  }
  return result.items.map((item) => ({ kind: "path", ...item }));
}

/** Opens the picker for the album; `onAdding` runs once a batch started. */
export async function startAdd(
  albumId: string,
  via: "library" | "camera" = "library",
  onAdding?: () => void,
) {
  const folderId = addableAlbum(albumId);
  if (!folderId) return;
  if (inNativeShell()) {
    const sources = await pickNative(via);
    if (sources && addPicked(folderId, sources, via)) onAdding?.();
    return;
  }
  fileInputRef.value?.click();
}

/** The hidden file input the page renders; `onAdding` runs once a batch started. */
export function pickerInput(albumId: string, onAdding?: () => void) {
  return html`<input
    ${ref(fileInputRef)}
    type="file"
    accept="image/*"
    multiple
    class="hidden"
    @change=${(e: Event) => {
      const input = e.target as HTMLInputElement;
      const sources = imageFiles(input.files).map((file): AddSource => ({ kind: "file", file }));
      if (addPicked(albumId, sources, "library")) onAdding?.();
      input.value = "";
    }}
  />`;
}
