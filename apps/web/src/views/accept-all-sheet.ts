import { type AcceptAllRole, requests } from "../machines/requests-machine";
import { copy, t } from "../copy/copy";
import { html, type TemplateResult } from "lit-html";
import { modalDialog } from "./modal-dialog";
import type { peopleViewModel } from "../machines/people-machine";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import { requestIdentity } from "./album";
import type { requestsViewModel } from "../machines/requests-machine";

type Rows = ReturnType<typeof peopleViewModel>["requests"];

/** The role of the Accept all button that opened the sheet, so focus goes back to it on close. */
let openedWith: AcceptAllRole = "reader";

// The Accept all button is disabled by the tap that opens this sheet, so the browser has
// already dropped focus from it: name it, or focus would land on <body> when the sheet closes.
const acceptAllModal = modalDialog(
  () => document.querySelector(`[data-accept-all="${openedWith}"]`) ?? undefined,
);

interface SheetText {
  count: number;
  folderName: string;
}

/** The sheet's title, body and Accept button for the role picked. */
function sheetTextFor(role: AcceptAllRole, text: SheetText) {
  const { count, folderName } = text;
  if (role === "member") {
    return {
      title: copy("album.accept_all_sheet_title_collaborators", { count }),
      body: t("album.accept_all_sheet_body_collaborators", { folderName }),
      confirm: t("album.accept_all_sheet_confirm_collaborators", { count }),
    };
  }
  return {
    title: copy("album.accept_all_sheet_title", { count }),
    body: t("album.accept_all_sheet_body", { folderName }),
    confirm: t("album.accept_all_sheet_confirm", { count }),
  };
}

/** The sheet Accept all opens: names everyone it will let in, with their check codes, and what they can do. Nobody is answered until Accept. */
export function acceptAllSheetView(
  rows: Rows,
  id: string,
  sheet: ReturnType<typeof requestsViewModel>["acceptAllSheet"],
): TemplateResult | null {
  if (!sheet || sheet.folderId !== id) return null;
  openedWith = sheet.role;
  const listed = sheet.requesterKeys.flatMap((k) => {
    const row = rows.find((r) => r.folderId === id && r.requesterKey === k);
    return row ? [row] : [];
  });
  const count = sheet.requesterKeys.length;
  const text = sheetTextFor(sheet.role, { count, folderName: listed[0]?.folderName ?? "" });
  return html`<dialog class="ui-sheet-dialog" aria-label=${text.title} ${ref(acceptAllModal)}>
    <div class="justus-sheet ui-sheet">
      <h3 class="break-words text-base font-semibold text-fg">${text.title}</h3>
      <ul role="list" class="mt-3 max-h-[50vh] space-y-2 overflow-y-auto">
        ${repeat(
          listed,
          (r) => r.requesterKey,
          (r) => html`<li class="ui-request-card">${requestIdentity(r, null)}</li>`,
        )}
      </ul>
      <p class="mt-3 text-sm text-muted">${text.body}</p>
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
          ${text.confirm}
        </button>
      </div>
    </div>
  </dialog>`;
}
