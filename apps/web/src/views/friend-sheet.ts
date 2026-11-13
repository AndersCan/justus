import { html } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { friendSheetOf, friends, friendsActor } from "../machines/friends-machine";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { toast } from "./toast";
import { modalDialog } from "./modal-dialog";

import { copy, t } from "../copy/copy";
let opener: HTMLElement | null = null;
const friendModal = modalDialog(() => opener ?? undefined);

/** Remember the row that opened the sheet so focus can go back to it. */
export function rememberFocus(el: HTMLElement) {
  opener = el;
}

onOutput(friendsActor, (e) => {
  const name = (e.payload as { name: string }).name;
  if (e.type === "FRIEND_SAVED") toast(copy("friend_sheet.saved_as_a_friend", { name }));
  if (e.type === "FRIEND_REMOVED") toast(copy("friend_sheet.removed_from_friends", { name }));
  if (e.type === "FRIEND_NOT_REMOVED") {
    toast(copy("friend_sheet.couldn_t_remove_try_again", { name }));
  }
});

function closeSheet() {
  friends.close();
}

/** The sheet stays open between states, so autofocus has no say when the name field appears. */
function focusName(el?: Element) {
  if (!(el instanceof HTMLInputElement)) return;
  queueMicrotask(() => {
    el.focus();
    el.select();
  });
}

export function friendSheetView() {
  return watch(friendsActor, (snapshot) => {
    const sheet = friendSheetOf(snapshot);
    const names = snapshot.context.friends;
    if (
      (sheet.state !== "showingMember" &&
        sheet.state !== "namingFriend" &&
        sheet.state !== "savingFriend") ||
      !sheet.target
    ) {
      return null;
    }
    const target = sheet.target;
    const known = names[target.identity];
    const title = known ?? target.ownName;
    const busy = sheet.state === "savingFriend";
    let body;
    if (sheet.state === "showingMember") {
      body = html` ${known !== undefined ? html`<p class="mt-1 text-sm text-muted">${t("friend_sheet.saved_as_a_friend_2")}</p>` : null}
        <div class="mt-4 flex justify-end gap-2">
          <button class="ui-btn-ghost" data-dismiss @click=${closeSheet}>
            ${t("friend_sheet.close")}
          </button>
          ${
            known === undefined
              ? html`<button
                  class="ui-btn-primary"
                  data-friend-primary
                  autofocus
                  @click=${() => friends.add()}
                >
                  ${t("friend_sheet.add_to_friends")}
                </button>`
              : html`<button
                  class="ui-btn-primary"
                  data-friend-primary
                  autofocus
                  @click=${() => friends.rename()}
                >
                  ${t("friend_sheet.rename")}
                </button>`
          }
        </div>`;
    } else {
      body = html` <label class="mt-3 block text-sm font-medium text-fg" for="friend-name"
          >${t("friend_sheet.name")}</label
        >
        <input
          id="friend-name"
          data-friend-name
          autofocus
          ${ref(busy ? undefined : focusName)}
          class="ui-input mt-1 w-full"
          maxlength="40"
          placeholder=${copy("friend_sheet.their_name")}
          autocomplete="off"
          .value=${sheet.draft}
          ?disabled=${busy}
          @input=${(e: Event) => friends.type((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") friends.save();
          }}
        />
        <p class="mt-1 text-xs text-muted" aria-live="polite">
          ${
            sheet.draft.trim() === ""
              ? copy("friend_sheet.type_a_name_to_save")
              : copy("friend_sheet.only_you_see_this_name")
          }
        </p>
        ${sheet.error ? html`<p class="mt-1 text-xs text-danger-fg" role="alert">${sheet.error}</p>` : null}
        <div class="mt-4 flex justify-end gap-2">
          <button class="ui-btn-ghost" data-dismiss ?disabled=${busy} @click=${closeSheet}>
            ${t("friend_sheet.cancel")}
          </button>
          <button
            class="ui-btn-primary"
            ?disabled=${!sheet.canSave || busy}
            @click=${() => friends.save()}
          >
            ${t("friend_sheet.save")}
          </button>
        </div>`;
    }
    return html`<dialog class="ui-sheet-dialog" aria-label=${title} ${ref(friendModal)}>
      <div class="justus-sheet ui-sheet">
        <h3 class="break-words text-base font-semibold text-fg">${title}</h3>
        ${body}
      </div>
    </dialog>`;
  });
}
