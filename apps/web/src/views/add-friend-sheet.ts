import { html, nothing } from "lit-html";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { addFriend, addFriendActor } from "../machines/sharing/add-friend";
import type {
  FriendAnswer,
  FriendChoice,
  FriendRole,
} from "../machines/sharing/add-friend-machine";
import { nameList } from "../utils/people";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
let opener: HTMLElement | null = null;

onOutput(addFriendActor, (e) => {
  const { names, role } = e.payload as { names: string[]; role: FriendRole };
  const list = nameList(names);
  toast(
    role === "reader"
      ? copy("add_friend_sheet.asked_to_join_as_viewers", { names: list })
      : copy("add_friend_sheet.asked_to_join_as_collaborators", { names: list }),
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
  label: string,
  meaning: string,
  id: string,
  role: FriendRole,
  disabled: boolean,
) {
  return html`<button
    class="ui-btn-primary w-full"
    ?disabled=${disabled}
    aria-describedby=${id}
    @click=${() => addFriend.pickRole(role)}
  >
    <span class="flex w-full flex-col items-start text-left">
      <span>${label}</span>
      <span class="text-xs font-normal" id=${id} aria-hidden="true">${meaning}</span>
    </span>
  </button>`;
}

function answerLine(a: FriendAnswer) {
  if (a.outcome === "asked") return copy("add_friend_sheet.asked", { name: a.name });
  if (a.outcome === "waiting") {
    return copy("add_friend_sheet.doesn_t_have_justus_open", { name: a.name });
  }
  return a.outcome === "refused"
    ? copy("add_friend_sheet.couldn_t_add_from_here", { name: a.name })
    : copy("add_friend_sheet.couldn_t_reach_ask_to", { name: a.name });
}

const closeButton = html`<div class="mt-4 flex justify-end">
  <button class="ui-btn-primary" data-add-friend-primary @click=${closeSheet}>
    ${t("add_friend_sheet.close")}
  </button>
</div>`;

export function addFriendSheetView() {
  return watch(addFriendActor, (snapshot) => {
    const state = snapshot.path[0];
    const p = (snapshot.payload ?? {}) as {
      albumName: string;
      choices: FriendChoice[];
      friends: FriendChoice[];
      answers: FriendAnswer[];
    };
    const ticked = snapshot.context.ticked;
    const title = copy("add_friend_sheet.add_a_friend_to", { albumName: p.albumName });
    let body;
    if (state === "choosingFriends") {
      const names = nameList(
        p.choices.filter((c) => ticked.includes(c.identity)).map((c) => c.name),
      );
      const none = ticked.length === 0;
      body = html`<ul class="mt-3 divide-y divide-line">
          ${p.choices.map(
            (c, i) => html`<li>
              <label
                class="flex w-full cursor-pointer items-center justify-between gap-2 py-3 text-sm font-medium text-fg"
              >
                <span class="min-w-0 break-words">${c.name}</span>
                <input
                  type="checkbox"
                  class="h-5 w-5 shrink-0"
                  data-add-friend-primary=${i === 0 ? "" : nothing}
                  .checked=${ticked.includes(c.identity)}
                  @change=${() => addFriend.toggleFriend(c.identity)}
                />
              </label>
            </li>`,
          )}
        </ul>
        <div class="mt-3 flex flex-col gap-2">
          ${roleButton(
            copy("add_friend_sheet.add_as_viewers", { names }),
            copy("add_friend_sheet.viewer_meaning"),
            "add-friend-viewer-meaning",
            "reader",
            none,
          )}
          ${roleButton(
            copy("add_friend_sheet.add_as_collaborators", { names }),
            copy("add_friend_sheet.collaborator_meaning"),
            "add-friend-collaborator-meaning",
            "member",
            none,
          )}
        </div>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-ghost" @click=${closeSheet}>${t("add_friend_sheet.close")}</button>
        </div>`;
    } else if (state === "askingFriends") {
      body = html`<div class="mt-3 flex items-center gap-3" role="status">
        <span
          class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-fg motion-reduce:animate-none"
        ></span>
        <div>
          <p class="text-sm font-medium text-fg">
            ${t("add_friend_sheet.asking", { name: nameList(p.friends.map((f) => f.name)) })}
          </p>
          <p class="text-sm text-muted">${t("add_friend_sheet.if_doesn_t_have_justus")}</p>
        </div>
      </div>`;
    } else if (state === "showingWhoWasAsked") {
      body = html`<ul class="mt-3 flex flex-col gap-2 text-sm text-fg" role="status">
          ${p.answers.map((a) => html`<li>${answerLine(a)}</li>`)}
        </ul>
        ${closeButton}`;
    } else {
      return null;
    }
    focusInSheet();
    return html`<div
      class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
      @click=${() => state !== "askingFriends" && closeSheet()}
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
