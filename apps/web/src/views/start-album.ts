import { html, render } from "lit-html";
import {
  $activeFolderId,
  $foldersError,
  $foldersState,
  folders,
} from "../machines/folders-machine";

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
            class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Start an album"
            @click=${(e: Event) => e.stopPropagation()}
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector("input");
              const name = input?.value.trim() ?? "";
              if (name) close(name);
            }}
          >
            <h3 class="text-base font-semibold text-fg">Start an album</h3>
            <p class="mt-1 text-sm text-muted">${detail}</p>
            <input
              class="ui-input mt-4 w-full"
              placeholder="Album name, e.g. Summer 2026"
              aria-label="Album name"
              maxlength="60"
              required
            />
            <div class="mt-4 flex justify-end gap-2">
              <button class="ui-btn-ghost" type="button" @click=${() => close(null)}>Cancel</button>
              <button class="ui-btn-primary" type="submit">${confirmLabel}</button>
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
  if ($foldersState.get() !== "ok") return Promise.resolve(null);
  return new Promise((resolve) => {
    let started = false;
    const stop = $foldersState.listen((state) => {
      if (state === "creating") {
        started = true;
        return;
      }
      if (!started) return;
      stop();
      resolve(state === "ok" && !$foldersError.get() ? $activeFolderId.get() : null);
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
  confirmLabel = "Create album",
): Promise<string | null> {
  const name = await askAlbumName(detail, confirmLabel);
  if (!name) return null;
  return createAlbum(name);
}
