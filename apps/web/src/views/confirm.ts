import { html, render } from "lit-html";

/** Warm inline confirmation sheet. Resolves true when the confirm button is
 * pressed, false on Keep / Escape / backdrop tap. Renders into its own
 * overlay so the calling view keeps its DOM untouched. */

type ConfirmOptions = {
  title: string;
  detail?: string;
  confirmLabel: string;
  tone?: "brick" | "clay";
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
      options.tone === "brick"
        ? "rounded-full min-h-11 px-5 py-2.5 text-sm font-semibold text-linen bg-brick hover:bg-brick/90 shadow-[0_4px_12px_rgba(179,69,47,.35)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick/30"
        : "warm-pill";
    render(
      html`
        <div
          class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-ink/40 backdrop-blur-[2px] sm:items-center"
          @click=${() => close(false)}
        >
          <div
            class="justus-sheet w-full max-w-sm rounded-t-3xl bg-linen p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-4px_24px_rgba(60,35,10,.18)] sm:rounded-3xl"
            role="dialog"
            aria-modal="true"
            aria-label=${options.title}
            @click=${(e: Event) => e.stopPropagation()}
          >
            <h3 class="break-words font-serif text-lg text-ink">${options.title}</h3>
            ${
              options.detail ? html`<p class="mt-1 text-sm text-cocoa">${options.detail}</p>` : null
            }
            <div class="mt-4 flex justify-end gap-2">
              <button class="warm-ghost" @click=${() => close(false)}>Keep</button>
              <button class=${toneClass} @click=${() => close(true)}>
                ${options.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      `,
      host,
    );
    host.querySelector<HTMLButtonElement>("button.warm-ghost")?.focus();
  });
}
