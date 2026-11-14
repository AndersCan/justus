import { html, type TemplateResult } from "lit-html";
import { friendlyError } from "../utils/friendly-error";

import { t } from "../copy/copy";
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
  return html`<div class="ui-error-banner" role="alert" title=${error}>
    ${friendlyError(error)}
    ${
      onReload
        ? html`<button class="ui-error-banner-action" @click=${onReload}>
            ${t("error_banner.reload_app")}
          </button>`
        : null
    }
    ${
      onRetry
        ? html`<button class="ui-error-banner-action" @click=${onRetry}>
            ${t("error_banner.retry")}
          </button>`
        : null
    }
  </div>`;
}
