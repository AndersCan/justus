import { html, render } from "lit-html";

/** Tiny warm toast system: `toast("Photo removed")`. Renders a stacked
 * container in the bottom-left (safe-area aware); toasts fade after ~3s. */

type Toast = { id: number; message: string };

let toasts: Toast[] = [];
let nextId = 0;
let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2 px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))]";
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
            class="justus-toast pointer-events-auto rounded-2xl bg-ink px-4 py-3 text-sm text-linen shadow-[0_4px_16px_rgba(60,35,10,.25)] ring-1 ring-line-strong"
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
