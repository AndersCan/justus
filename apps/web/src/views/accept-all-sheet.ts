import { html, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { requests, requestsViewModel } from "../machines/requests-machine";
import type { peopleViewModel } from "../machines/people-machine";
import { copy, t } from "../copy/copy";
import { requestIdentity } from "./album";

type Rows = ReturnType<typeof peopleViewModel>["requests"];

function focusCancel() {
  queueMicrotask(() => {
    const el = document.querySelector<HTMLButtonElement>("[data-accept-all-cancel]");
    if (el && document.activeElement !== el) el.focus();
  });
}

/** The sheet Accept all opens: names everyone it will let in, with their check codes. Nobody is answered until Accept. */
export function acceptAllSheetView(
  rows: Rows,
  id: string,
  sheet: ReturnType<typeof requestsViewModel>["acceptAllSheet"],
): TemplateResult | null {
  if (!sheet || sheet.folderId !== id) return null;
  const listed = sheet.requesterKeys.flatMap((k) => {
    const row = rows.find((r) => r.folderId === id && r.requesterKey === k);
    return row ? [row] : [];
  });
  const count = sheet.requesterKeys.length;
  const title = copy("album.accept_all_sheet_title", { count });
  focusCancel();
  return html`<div
    class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
    @click=${() => requests.cancelAcceptAll()}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") requests.cancelAcceptAll();
    }}
  >
    <div
      class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
      role="dialog"
      aria-modal="true"
      aria-label=${title}
      @click=${(e: Event) => e.stopPropagation()}
    >
      <h3 class="break-words text-base font-semibold text-fg">${title}</h3>
      <ul role="list" class="mt-3 max-h-[50vh] space-y-2 overflow-y-auto">
        ${repeat(
          listed,
          (r) => r.requesterKey,
          (r) => html`<li class="rounded-xl bg-subtle p-3">${requestIdentity(r, null)}</li>`,
        )}
      </ul>
      <p class="mt-3 text-sm text-muted">
        ${t("album.accept_all_sheet_body", { folderName: listed[0]?.folderName ?? "" })}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="ui-btn-ghost"
          data-accept-all-cancel
          @click=${() => requests.cancelAcceptAll()}
        >
          ${t("album.accept_all_sheet_cancel")}
        </button>
        <button class="ui-btn-primary" @click=${() => requests.confirmAcceptAll()}>
          ${t("album.accept_all_sheet_confirm", { count })}
        </button>
      </div>
    </div>
  </div>`;
}
