import { html, render } from "lit-html";

import { t } from "../copy/copy";
/** Warm confirmation dialog. Resolves true when the confirm button is
 * pressed, false on Keep / Escape / backdrop tap / close. Renders into its own
 * host so the calling view keeps its DOM untouched. */

type ConfirmOptions = {
  title: string;
  detail?: string;
  confirmLabel: string;
  /** The button that backs out; defaults to Keep. */
  cancelLabel?: string;
  tone?: "danger" | "accent";
};

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let result = false;
    const dialog = () =>
      host.querySelector("wa-dialog") as (HTMLElement & { open: boolean }) | null;
    const finish = (value: boolean) => {
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
    // without-header: the built-in close X loads a data: icon,
    // which the CSP blocks. Keep, Escape and a tap outside all close it.
    render(
      html`
        <wa-dialog
          label=${options.title}
          without-header
          light-dismiss
          open
          @wa-after-hide=${onAfterHide}
        >
          <h3 class="break-words text-base font-semibold text-fg">${options.title}</h3>
          ${options.detail ? html`<p class="text-sm text-muted">${options.detail}</p>` : null}
          <wa-button slot="footer" appearance="filled" autofocus @click=${() => finish(false)}>
            ${options.cancelLabel ?? t("confirm.keep")}
          </wa-button>
          <wa-button
            slot="footer"
            variant=${options.tone === "danger" ? "danger" : "neutral"}
            appearance="accent"
            @click=${() => finish(true)}
          >
            ${options.confirmLabel}
          </wa-button>
        </wa-dialog>
      `,
      host,
    );
    // The dialog's own autofocus can run before the buttons are upgraded.
    void customElements.whenDefined("wa-button").then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() =>
          host.querySelector<HTMLElement>("wa-button[autofocus]")?.focus(),
        );
      });
    });
  });
}
