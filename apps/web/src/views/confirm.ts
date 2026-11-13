import { html, render } from "lit-html";

import { button } from "#design/components/button.ts";

import { copy } from "../copy/copy";
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
          <div slot="footer" class="flex flex-wrap justify-end gap-2">
            ${button({
              label: options.cancelLabel ?? copy("confirm.keep"),
              variant: "default",
              size: "large",
              onClick: () => finish(false),
            })}
            ${button({
              label: options.confirmLabel,
              variant: options.tone === "danger" ? "danger" : "primary",
              size: "large",
              onClick: () => finish(true),
            })}
          </div>
        </wa-dialog>
      `,
      host,
    );
    // The dialog's own autofocus can run before it is upgraded.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => host.querySelector<HTMLElement>("[slot=footer]>button")?.focus());
    });
  });
}
