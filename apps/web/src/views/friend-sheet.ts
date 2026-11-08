import { html } from "lit-html";
import { friendSheetOf, friends, friendsActor } from "../machines/friends-machine";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
let opener: HTMLElement | null = null;

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
  const el = opener;
  opener = null;
  queueMicrotask(() => el?.isConnected && el.focus());
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeSheet();
}

function focusOnRender(selector: string) {
  queueMicrotask(() => {
    const el = document.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
    if (!el || document.activeElement === el) return;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
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
      focusOnRender("[data-friend-primary]");
      body = html` ${known !== undefined ? html`<p class="mt-1 text-sm text-muted">${t("friend_sheet.saved_as_a_friend_2")}</p>` : null}
        <div class="mt-4 flex justify-end gap-2">
          <button class="ui-btn-ghost" @click=${closeSheet}>${t("friend_sheet.close")}</button>
          ${
            known === undefined
              ? html`<button
                  class="ui-btn-primary"
                  data-friend-primary
                  @click=${() => friends.add()}
                >
                  ${t("friend_sheet.add_to_friends")}
                </button>`
              : html`<button
                  class="ui-btn-primary"
                  data-friend-primary
                  @click=${() => friends.rename()}
                >
                  ${t("friend_sheet.rename")}
                </button>`
          }
        </div>`;
    } else {
      focusOnRender("[data-friend-name]");
      body = html` <label class="mt-3 block text-sm font-medium text-fg" for="friend-name"
          >${t("friend_sheet.name")}</label
        >
        <input
          id="friend-name"
          data-friend-name
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
          <button class="ui-btn-ghost" ?disabled=${busy} @click=${closeSheet}>
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
    return html`<div
      class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
      @click=${closeSheet}
      @keydown=${onKey}
    >
      <div
        class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-label=${title}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <h3 class="break-words text-base font-semibold text-fg">${title}</h3>
        ${body}
      </div>
    </div>`;
  });
}
