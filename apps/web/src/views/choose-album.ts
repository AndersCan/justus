import { html, render } from "lit-html";
import type { FolderSummary } from "@justus/core";

/** "Add to which album?" sheet. Resolves the chosen album's id, or null on
 * Cancel / Escape / backdrop tap. Same overlay pattern as `confirmAction`. */
export function chooseAlbum(albums: FolderSummary[], suggestedId: string | null) {
  return new Promise<string | null>((resolve) => {
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
    const ordered = [
      ...albums.filter((a) => a.id === suggestedId),
      ...albums.filter((a) => a.id !== suggestedId),
    ];
    render(
      html`
        <div
          class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
          @click=${() => close(null)}
        >
          <div
            class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Add to which album?"
            @click=${(e: Event) => e.stopPropagation()}
          >
            <h3 class="text-base font-semibold text-fg">Add to which album?</h3>
            <p class="mt-1 text-sm text-muted">Everyone in that album will see the photo.</p>
            <ul class="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
              ${ordered.map(
                (album) => html`<li>
                  <button
                    class="ui-focus flex w-full items-center justify-between gap-3 rounded-xl bg-subtle px-4 py-3 text-left hover:bg-line"
                    @click=${() => close(album.id)}
                  >
                    <span class="truncate font-medium text-fg">${album.name}</span>
                    <span class="shrink-0 text-xs text-muted">
                      ${album.members} member${album.members === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>`,
              )}
            </ul>
            <div class="mt-4 flex justify-end">
              <button class="ui-btn-ghost" @click=${() => close(null)}>Cancel</button>
            </div>
          </div>
        </div>
      `,
      host,
    );
    host.querySelector<HTMLButtonElement>("ul button")?.focus();
  });
}
