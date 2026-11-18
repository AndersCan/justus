import { html, render } from "lit-html";

import { copy } from "../copy/copy";

type Choice = { key: string; name: string };

/** Asks the Admin whom to hand the album to. Resolves the chosen person's key, or null when the sheet is closed. */
export function chooseNewAdmin(
  albumName: string,
  choices: readonly Choice[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let result: string | null = null;
    const dialog = () =>
      host.querySelector("wa-dialog") as (HTMLElement & { open: boolean }) | null;
    const finish = (value: string | null) => {
      result = value;
      const el = dialog();
      if (el) el.open = false;
    };
    const onAfterHide = (e: Event) => {
      if (e.target !== e.currentTarget) return;
      render(null, host);
      host.remove();
      previouslyFocused?.focus();
      resolve(result);
    };
    render(
      html`
        <wa-dialog
          label=${copy("hand_over_sheet.who_takes_over", { album: albumName })}
          without-header
          light-dismiss
          open
          @wa-after-hide=${onAfterHide}
        >
          <h3 class="break-words text-base font-semibold text-fg">
            ${copy("hand_over_sheet.who_takes_over", { album: albumName })}
          </h3>
          <ul class="mt-3 space-y-2">
            ${choices.map(
              (c) => html`<li>
                <button
                  class="ui-btn-ghost w-full min-w-0 justify-start text-left [overflow-wrap:anywhere]"
                  data-new-admin=${c.key}
                  @click=${() => finish(c.key)}
                >
                  <span class="block">${c.name}</span>
                  <span class="block text-xs text-muted"
                    >${copy("hand_over_sheet.can_add_photos_now")}</span
                  >
                </button>
              </li>`,
            )}
          </ul>
          <div slot="footer" class="flex justify-end">
            <button class="ui-btn-ghost" data-dismiss @click=${() => finish(null)}>
              ${copy("hand_over_sheet.close")}
            </button>
          </div>
        </wa-dialog>
      `,
      host,
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => host.querySelector<HTMLElement>("[data-new-admin]")?.focus());
    });
  });
}
