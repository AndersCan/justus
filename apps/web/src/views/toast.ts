import { html, render } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { onPageChange } from "../machines/router-machine";
import { gridMotion } from "./grid-motion";

/** Tiny toast system: `toast("Photo removed")`. Renders a stacked
 * container in the bottom-left (safe-area aware); toasts fade out after ~3s,
 * or ~6s when they carry an action (`toast("Added", { action })`); `onClose` runs when the time is up, even after the action was tapped; the others
 * slide into place. A toast belongs to the page it was raised on: leaving that page closes it
 * (`onClose` still runs at its time). One raised right after `open()` belongs to the new page. */

type ToastAction = { label: string; run: () => void };
type Toast = { id: number; message: string; action?: ToastAction; path: string };

let toasts: Toast[] = [];
let nextId = 0;
let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  // Inside the open sheet, else the sheet's modal would make toasts untappable.
  const parent = [...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body;
  if (host) {
    if (host.parentElement !== parent) parent.appendChild(host);
    return host;
  }
  host = document.createElement("div");
  host.dataset.toastHost = "";
  host.className =
    "pointer-events-none fixed bottom-20 left-4 z-50 md:bottom-4 px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))]";
  parent.appendChild(host);
  return host;
}

const toastKey = (t: Toast) => String(t.id);

function paint() {
  const el = ensureHost();
  render(
    html`
      <div
        class="flex flex-col gap-2"
        ${gridMotion({ keys: toasts.map(toastKey), settle: "toasts" })}
      >
        ${repeat(
          toasts,
          toastKey,
          (t) => html`
            <div data-motion-key=${toastKey(t)} class="justus-toast ui-toast" role="status">
              <span>${t.message}</span>
              ${
                t.action
                  ? html`<button
                      class="ui-toast-action"
                      @click=${() => {
                        dismiss(t.id);
                        t.action?.run();
                      }}
                    >
                      ${t.action.label}
                    </button>`
                  : null
              }
            </div>
          `,
        )}
      </div>
    `,
    el,
  );
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  paint();
}

/** Shows a toast. Returns a function that removes it at once; `onClose` still runs when its time is up. */
export function toast(
  message: string,
  options: { action?: ToastAction; duration?: number; onClose?: () => void } = {},
): () => void {
  const id = ++nextId;
  toasts = [...toasts, { id, message, action: options.action, path: location.pathname }];
  paint();
  setTimeout(
    () => {
      dismiss(id);
      options.onClose?.();
    },
    options.duration ?? (options.action ? 6000 : 3200),
  );
  return () => dismiss(id);
}

onPageChange(() => {
  const here = location.pathname;
  if (toasts.every((t) => t.path === here)) return;
  toasts = toasts.filter((t) => t.path === here);
  paint();
});
