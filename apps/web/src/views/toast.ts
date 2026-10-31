import { html, render } from "lit-html";

/** Tiny toast system: `toast("Photo removed")`. Renders a stacked
 * container in the bottom-left (safe-area aware); toasts fade after ~3s, or
 * ~6s when they carry an action (`toast("Added", { action })`). */

type ToastAction = { label: string; run: () => void };
type Toast = { id: number; message: string; action?: ToastAction };

let toasts: Toast[] = [];
let nextId = 0;
let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed bottom-20 left-4 z-50 md:bottom-4 flex flex-col gap-2 px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))]";
  document.body.appendChild(host);
  return host;
}

function paint() {
  const el = ensureHost();
  render(
    html`
      ${toasts.map(
        (t) => html`
          <div
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
    `,
    el,
  );
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  paint();
}

export function toast(message: string, options: { action?: ToastAction } = {}): void {
  const id = ++nextId;
  toasts = [...toasts, { id, message, action: options.action }];
  paint();
  setTimeout(() => dismiss(id), options.action ? 6000 : 3200);
}
