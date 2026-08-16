import { html, type TemplateResult } from "lit-html";

/** Error banner shared by the gallery and sync views; shows a retry button
 * when the view is in its recoverable error state (pass a handler then), and
 * a reload button when the underlying actor is dead (mantaq `__error`), where
 * retrying is a no-op. */
export function errorBanner(
  error: string | null,
  onRetry?: () => void,
  onReload?: () => void,
): TemplateResult | null {
  if (!error) return null;
  return html`<div
    class="rounded-2xl border border-brick/40 bg-brick/10 px-4 py-3 text-sm text-brick"
  >
    ${error}
    ${
      onReload
        ? html`<button
            class="ml-2 rounded font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick/40"
            @click=${onReload}
          >
            Reload app
          </button>`
        : null
    }
    ${
      onRetry
        ? html`<button
            class="ml-2 rounded font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brick/40"
            @click=${onRetry}
          >
            Retry
          </button>`
        : null
    }
  </div>`;
}
