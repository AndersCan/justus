import { html, nothing } from "lit-html";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { addFriend, addFriendActor } from "../machines/sharing/add-friend";
import type {
  FriendChoice,
  FriendRole,
  NotReachedReason,
} from "../machines/sharing/add-friend-machine";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
let opener: HTMLElement | null = null;

onOutput(addFriendActor, (e) => {
  const { name, role } = e.payload as { name: string; role: FriendRole };
  toast(
    role === "reader"
      ? copy("add_friend_sheet.asked_to_join_as_viewer", { name })
      : copy("add_friend_sheet.asked_to_join_as_collaborator", { name }),
  );
});

/** Opens the sheet for this album. Focus goes back to the button when it closes. */
export function openAddFriend(
  button: HTMLElement,
  album: { folderId: string; albumName: string },
  friends: Record<string, string>,
  memberIdentities: string[],
) {
  opener = button;
  addFriend.openPicker({
    ...album,
    friends: Object.entries(friends).map(([identity, name]) => ({ identity, name })),
    memberIdentities,
  });
}

function closeSheet() {
  addFriend.closePicker();
  const el = opener;
  opener = null;
  queueMicrotask(() => el?.isConnected && el.focus());
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeSheet();
}

function focusInSheet() {
  setTimeout(() => {
    const el =
      document.querySelector<HTMLElement>("[data-add-friend-primary]") ??
      document.querySelector<HTMLElement>("[data-add-friend-dialog]");
    if (el && document.activeElement !== el) el.focus();
  }, 0);
}

function roleButton(
  primary: boolean,
  label: string,
  meaning: string,
  id: string,
  role: FriendRole,
) {
  return html`<button
    class="ui-btn-primary w-full"
    data-add-friend-primary=${primary ? "" : nothing}
    aria-describedby=${id}
    @click=${() => addFriend.pickRole(role)}
  >
    <span class="flex w-full flex-col items-start text-left">
      <span>${label}</span>
      <span class="text-xs font-normal" id=${id} aria-hidden="true">${meaning}</span>
    </span>
  </button>`;
}

function notReached(name: string, reason: NotReachedReason) {
  return reason === "refused"
    ? copy("add_friend_sheet.couldn_t_add_from_here", { name })
    : copy("add_friend_sheet.couldn_t_reach_ask_to", { name });
}

export function addFriendSheetView() {
  return watch(addFriendActor, (snapshot) => {
    const state = snapshot.path[0];
    const p = (snapshot.payload ?? {}) as {
      albumName: string;
      choices: FriendChoice[];
      name: string;
      reason: NotReachedReason;
    };
    let title = copy("add_friend_sheet.add_a_friend_to", { albumName: p.albumName });
    let body;
    if (state === "choosingFriend") {
      body = html`<ul class="mt-3 divide-y divide-line">
          ${p.choices.map(
            (c, i) => html`<li>
              <button
                data-add-friend-primary=${i === 0 ? "" : nothing}
                class="w-full break-words py-3 text-left text-sm font-medium text-fg"
                @click=${() => addFriend.pickFriend(c.identity)}
              >
                ${c.name}
              </button>
            </li>`,
          )}
        </ul>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-ghost" @click=${closeSheet}>${t("add_friend_sheet.close")}</button>
        </div>`;
    } else if (state === "choosingFriendRole") {
      title = copy("add_friend_sheet.add_to", { name: p.name, albumName: p.albumName });
      body = html`<div class="mt-3 flex flex-col gap-2">
          ${roleButton(
            true,
            copy("add_friend_sheet.add_as_viewer", { name: p.name }),
            copy("add_friend_sheet.viewer_meaning"),
            "add-friend-viewer-meaning",
            "reader",
          )}
          ${roleButton(
            false,
            copy("add_friend_sheet.add_as_collaborator", { name: p.name }),
            copy("add_friend_sheet.collaborator_meaning"),
            "add-friend-collaborator-meaning",
            "member",
          )}
        </div>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-ghost" @click=${closeSheet}>${t("add_friend_sheet.close")}</button>
        </div>`;
    } else if (state === "lookingForFriend") {
      body = html`<div class="mt-3 flex items-center gap-3" role="status">
        <span
          class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-fg motion-reduce:animate-none"
        ></span>
        <div>
          <p class="text-sm font-medium text-fg">
            ${t("add_friend_sheet.asking", { name: p.name })}
          </p>
          <p class="text-sm text-muted">
            ${t("add_friend_sheet.if_doesn_t_have_justus", { name: p.name })}
          </p>
        </div>
      </div>`;
    } else if (state === "inviteWaitingForFriend") {
      body = html`<p class="mt-3 text-sm text-fg" role="status">
          ${t("add_friend_sheet.doesn_t_have_justus_open", { name: p.name })}
        </p>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-primary" data-add-friend-primary @click=${closeSheet}>
            ${t("add_friend_sheet.close")}
          </button>
        </div>`;
    } else if (state === "couldNotReachFriend") {
      body = html`<p class="mt-3 text-sm text-fg" role="alert">${notReached(p.name, p.reason)}</p>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-primary" data-add-friend-primary @click=${closeSheet}>
            ${t("add_friend_sheet.close")}
          </button>
        </div>`;
    } else {
      return null;
    }
    focusInSheet();
    return html`<div
      class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
      @click=${() => state !== "lookingForFriend" && closeSheet()}
      @keydown=${onKey}
    >
      <div
        class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
        role="dialog"
        tabindex="-1"
        data-add-friend-dialog
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
