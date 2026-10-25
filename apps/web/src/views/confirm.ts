import { html, render } from "lit-html";

/** Warm inline confirmation sheet. Resolves true when the confirm button is
 * pressed, false on Keep / Escape / backdrop tap. Renders into its own
 * overlay so the calling view keeps its DOM untouched. */

type ConfirmOptions = {
  title: string;
  detail?: string;
  confirmLabel: string;
  tone?: "danger" | "accent";
};

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      render(null, host);
      host.remove();
      previouslyFocused?.focus();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    document.addEventListener("keydown", onKey);
    const toneClass =
      options.tone === "danger"
        ? "ui-btn bg-danger text-white hover:bg-danger/90"
        : "ui-btn-primary";
    render(
      html`
        <div
          class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
          @click=${() => close(false)}
        >
          <div
            class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label=${options.title}
            @click=${(e: Event) => e.stopPropagation()}
          >
            <h3 class="break-words text-base font-semibold text-fg">${options.title}</h3>
            ${options.detail ? html`<p class="mt-1 text-sm text-muted">${options.detail}</p>` : null}
            <div class="mt-4 flex justify-end gap-2">
              <button class="ui-btn-ghost" @click=${() => close(false)}>Keep</button>
              <button class=${toneClass} @click=${() => close(true)}>
                ${options.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      `,
      host,
    );
    host.querySelector<HTMLButtonElement>("button.ui-btn-ghost")?.focus();
  });
}
