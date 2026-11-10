import { html, render } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { gridMotion } from "./grid-motion";

/** Tiny toast system: `toast("Photo removed")`. Renders a stacked
 * container in the bottom-left (safe-area aware); toasts fade out after ~3s,
 * or ~6s when they carry an action (`toast("Added", { action })`); `onClose` runs when the time is up, even after the action was tapped; the others
 * slide into place. */

type ToastAction = { label: string; run: () => void };
type Toast = { id: number; message: string; action?: ToastAction };

let toasts: Toast[] = [];
let nextId = 0;
let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed bottom-20 left-4 z-50 md:bottom-4 px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))]";
  document.body.appendChild(host);
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
            <div
              data-motion-key=${toastKey(t)}
              class="justus-toast pointer-events-auto flex items-center gap-4 rounded-xl bg-fg px-4 py-3 text-sm text-canvas shadow-lg"
              role="status"
            >
              <span>${t.message}</span>
              ${
                t.action
                  ? html`<button
                      class="ui-focus -my-1 shrink-0 rounded-md px-2 py-1 font-semibold underline-offset-2 hover:underline"
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

export function toast(
  message: string,
  options: { action?: ToastAction; duration?: number; onClose?: () => void } = {},
): void {
  const id = ++nextId;
  toasts = [...toasts, { id, message, action: options.action }];
  paint();
  setTimeout(
    () => {
      dismiss(id);
      options.onClose?.();
    },
    options.duration ?? (options.action ? 6000 : 3200),
  );
}
