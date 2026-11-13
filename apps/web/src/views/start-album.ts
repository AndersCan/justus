import { html, render } from "lit-html";
import {
  FOLDERS_STATES,
  folders,
  foldersActor,
  foldersViewModel,
} from "../machines/folders-machine";
import { onStateChange } from "../machines/actor-utils";

import { copy, t } from "../copy/copy";
/** "Start an album" sheet, for "New album" and "Start an album" in Photos.
 * Resolves the new album's name, or
 * null on Cancel / Escape / backdrop tap. Same overlay pattern as
 * `confirmAction`. */
function askAlbumName(detail: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (result: string | null) => {
      document.removeEventListener("keydown", onKey);
      render(null, host);
      host.remove();
      previouslyFocused?.focus();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    render(
      html`
        <div
          class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
          @click=${() => close(null)}
        >
          <form
            class="justus-sheet ui-sheet"
            role="dialog"
            aria-modal="true"
            aria-label=${copy("start_album.start_an_album")}
            @click=${(e: Event) => e.stopPropagation()}
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector("input");
              const name = input?.value.trim() ?? "";
              if (name) close(name);
            }}
          >
            <h3 class="text-base font-semibold text-fg">${t("start_album.start_an_album")}</h3>
            <p class="mt-1 text-sm text-muted">${detail}</p>
            <input
              class="ui-input mt-4 w-full"
              placeholder=${copy("start_album.album_name_e_g_summer")}
              aria-label=${copy("start_album.album_name")}
              maxlength="60"
              required
            />
            <div class="mt-4 flex justify-end gap-2">
              <button class="ui-btn-ghost" type="button" @click=${() => close(null)}>
                ${t("start_album.cancel")}
              </button>
              <wa-button variant="brand" type="submit">${confirmLabel}</wa-button>
            </div>
          </form>
        </div>
      `,
      host,
    );
    host.querySelector<HTMLInputElement>("input")?.focus();
  });
}

/** Creates an album through the folders actor and resolves its id once the
 * create lands (null if it fails or the actor is busy). */
function createAlbum(name: string): Promise<string | null> {
  if (!foldersViewModel(foldersActor.snapshot()).settled) return Promise.resolve(null);
  return new Promise((resolve) => {
    let started = false;
    const stop = onStateChange(foldersActor, FOLDERS_STATES, (state) => {
      if (state === "creatingAlbum") {
        started = true;
        return;
      }
      if (!started) return;
      stop();
      const { error, activeId } = foldersActor.snapshot().context;
      resolve(state === "showingAlbums" && !error ? activeId : null);
    });
    folders.create(name);
    // A create the actor refused never leaves `ok`.
    setTimeout(() => {
      if (started) return;
      stop();
      resolve(null);
    }, 1000);
  });
}

/** Asks for a name and creates the album. Resolves its id, or null. */
export async function startAlbum(
  detail: string,
  confirmLabel = copy("start_album.create_album"),
): Promise<string | null> {
  const name = await askAlbumName(detail, confirmLabel);
  if (!name) return null;
  return createAlbum(name);
}
