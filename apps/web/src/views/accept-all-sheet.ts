import { html, type TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { requests, requestsViewModel } from "../machines/requests-machine";
import type { peopleViewModel } from "../machines/people-machine";
import { copy, t } from "../copy/copy";
import { requestIdentity } from "./album";
import { modalDialog } from "./modal-dialog";

type Rows = ReturnType<typeof peopleViewModel>["requests"];

const acceptAllModal = modalDialog();

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
  return html`<dialog class="ui-sheet-dialog" aria-label=${title} ${ref(acceptAllModal)}>
    <div class="justus-sheet ui-sheet">
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
          data-dismiss
          autofocus
          @click=${() => requests.cancelAcceptAll()}
        >
          ${t("album.accept_all_sheet_cancel")}
        </button>
        <button class="ui-btn-primary" @click=${() => requests.confirmAcceptAll()}>
          ${t("album.accept_all_sheet_confirm", { count })}
        </button>
      </div>
    </div>
  </dialog>`;
}
