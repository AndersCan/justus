import { html, render } from "lit-html";

/** Tiny toast system: `toast("Photo removed")`. Renders a stacked
 * container in the bottom-left (safe-area aware); toasts fade after ~3s. */

type Toast = { id: number; message: string };

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
            class="justus-toast pointer-events-auto rounded-xl bg-fg px-4 py-3 text-sm text-canvas shadow-lg"
          >
            ${t.message}
          </div>
        `,
      )}
    `,
    el,
  );
}

export function toast(message: string): void {
  const id = ++nextId;
  toasts = [...toasts, { id, message }];
  paint();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    paint();
  }, 3200);
}
