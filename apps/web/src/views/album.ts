import type { FolderSummary, Photo } from "@justus/core";
import { arrivalFocusWithin } from "./arrival-focus";
import { renderAlbumFull } from "#design/justus/album/album-full.ts";
import { presenceDot } from "#design/components/presence-dot.ts";
import { html, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { ref } from "lit-html/directives/ref.js";
import { keyed } from "lit-html/directives/keyed.js";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { friends, friendsActor } from "../machines/friends-machine";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
import { presenceClockActor } from "../machines/presence-clock-machine";
import { people, peopleActor, peopleViewModel } from "../machines/people-machine";
import {
  allAcceptedAsViewers,
  declineHeld,
  declineNotSent,
  requestCancelledBeforeAnswer,
  answerSent,
  requests,
  requestsActor,
  requestsViewModel,
  viewerAcceptKeys,
} from "../machines/requests-machine";
import { galleryActor, galleryViewModel } from "../machines/gallery-machine";
import { onPageChange, open } from "../machines/router-machine";
import { inviteLink } from "../machines/sharing/invite-link";
import { sync, syncActor, syncViewModel } from "../machines/sync-machine";
import { friendlyError } from "../utils/friendly-error";
import { nameList, requestRowOf, requestsHint, type Person } from "../utils/people";
import {
  leaverHolders,
  memberHoldings,
  memberPhotosLine,
  type MemberHolding,
} from "../utils/holders";
import { photosInScope } from "../utils/photo-scope";
import { formatRelative, linkMadeText } from "../utils/time";
import { linkKindOf, type ValidFor } from "../machines/sharing/invite-link-machine";
import { memberBadge } from "./avatar";
import { roleLabel } from "./albums";
import { confirmAction } from "./confirm";
import { chooseNewAdmin } from "./hand-over-sheet";
import { errorBanner } from "./error-banner";
import { adminName, copyInviteLink, invitePanel } from "./invite";
import { albumNotice } from "./notices";
import { addFriendSheetView } from "./add-friend-sheet";
import { friendSheetView, rememberFocus } from "./friend-sheet";
import { acceptAllSheetView } from "./accept-all-sheet";
import { toast } from "./toast";
import { pickerInput, startAdd } from "./photo-picker";
import { planAdd } from "../utils/add-photos";
import { gridMotion } from "./grid-motion";

import { copy, t } from "../copy/copy";
/** What the Leave sheet says: for a Collaborator, how many photos they added, who loses them now or when their phone connects, and which no other phone has. */
export function leaveDetail(input: {
  role: "member" | "reader";
  adminName: string;
  /** This phone's own photos in the album; undefined while the photo list is not loaded. */
  mine: readonly Photo[] | undefined;
  people: readonly Pick<Person, "key" | "name" | "you" | "admin" | "connected">[];
}): string {
  const { adminName, mine, people } = input;
  if (input.role === "reader") return copy("album.it_disappears_from_this_phone_2", { adminName });
  const comeBack = copy("album.leave_come_back", { adminName });
  if (mine === undefined) return copy("album.it_disappears_from_this_phone", { adminName });
  if (mine.length === 0) return copy("album.leave_no_photos_added") + comeBack;
  const k = mine.length;
  const count = photoCount(k);
  const base =
    copy("album.leave_takes_your_photos", { count }) +
    copy("album.leave_photos_removed_everywhere", { count });
  const holders = leaverHolders(mine);
  if (holders.kind === "unknown") return base + comeBack;
  const named = people.filter((p) => !p.you && holders.keys.has(p.key));
  const now = named.filter((p) => p.admin && p.connected).map((p) => p.name);
  const later = named.filter((p) => !(p.admin && p.connected)).map((p) => p.name);
  const nowSays =
    now.length === 0
      ? ""
      : copy("album.leave_lose_them_now", { list: nameList(now), n: now.length, k });
  const laterSays =
    later.length === 0
      ? ""
      : copy("album.leave_lose_them_when_they_connect", {
          list: nameList(later),
          n: later.length,
          k,
        });
  const only =
    holders.sole === 0
      ? ""
      : copy("album.leave_only_on_your_phone", {
          count: photoCount(holders.sole),
          n: holders.sole,
        });
  return base + nowSays + laterSays + only + comeBack;
}

const photoCount = (n: number) => (n === 1 ? copy("album.1_photo") : copy("album.photos", { n }));

/** The delete sheet: with others it names who loses the album now and who when their phone connects; alone it is just this phone. */
export function deleteSheet(
  name: string,
  photos: number,
  others: readonly { name: string; connected: boolean }[],
) {
  const count = photoCount(photos);
  if (others.length === 0) {
    return {
      title: copy("album.delete", { name }),
      detail: copy("album.the_album_and_its_are", { count }),
    };
  }
  const now = others.filter((o) => o.connected).map((o) => o.name);
  const later = others.filter((o) => !o.connected).map((o) => o.name);
  return {
    title: copy("album.delete_for_everyone", { name }),
    detail: copy("album.the_album_and_its_including", {
      count,
      now:
        now.length === 0 ? "" : copy("album.lose_it_now", { list: nameList(now), n: now.length }),
      later:
        later.length === 0
          ? ""
          : copy("album.lose_it_when_they_connect", { list: nameList(later), n: later.length }),
    }),
  };
}

/** The dialog for a person the Admin removed: it deletes the album from this phone. */
export function removedDeleteSheet(name: string, adminName: string) {
  return {
    title: copy("album.delete_from_this_phone_title", { name }),
    detail: copy("album.you_re_no_longer_in_this", { adminName }),
    confirmLabel: copy("album.delete_2"),
  };
}

/** The ••• menu entries by role: everyone archives; the Admin deletes, others leave. */
export function albumMenuItems(
  role: "creator" | "member" | "reader",
  pending: boolean,
  removed = false,
  handover: { handing: boolean; collaborators: number } = { handing: false, collaborators: 0 },
  archived = false,
  name = "",
): {
  value: "archive" | "leave" | "delete" | "restore";
  label: string;
  hint?: string;
  danger: boolean;
}[] {
  if (archived) return [{ value: "restore", label: copy("albums.restore_2"), danger: false }];
  const archive = {
    value: "archive",
    label: copy("album.archive"),
    hint: copy("album.archive_hint", { name }),
    danger: false,
  } as const;
  if (pending) return [archive];
  if (role === "creator") {
    if (handover.handing) return [archive];
    const del = { value: "delete", label: copy("album.delete_album"), danger: true } as const;
    if (handover.collaborators === 0) return [archive, del];
    return [archive, { value: "leave", label: copy("album.leave_album"), danger: false }, del];
  }
  if (removed)
    return [archive, { value: "leave", label: copy("album.delete_from_this_phone"), danger: true }];
  return [archive, { value: "leave", label: copy("album.leave_album"), danger: true }];
}

/** The people an Admin can hand the album to: Collaborators other than themselves. */
export function handOverChoices(people: readonly Person[]): Person[] {
  return people.filter((p) => p.role === "collaborator" && !p.you && !p.admin);
}

export async function handOverAlbum(status: Status, people: readonly Person[]) {
  const { id, name } = status.folder;
  const choices = handOverChoices(people);
  const key =
    choices.length > 1
      ? await chooseNewAdmin(
          name,
          choices.map((c) => ({ key: c.key, name: c.name })),
        )
      : (choices[0]?.key ?? null);
  const chosen = choices.find((c) => c.key === key);
  if (!chosen) return;
  await confirmHandOver({ id, name }, chosen);
}

/** Ask Ada to confirm, then hand the album to this person. */
export async function confirmHandOver(
  folder: { id: string; name: string },
  person: Pick<Person, "key" | "name">,
) {
  const ok = await confirmAction({
    title: copy("album.hand_over_title", { album: folder.name, name: person.name }),
    detail: copy("album.hand_over_detail", { album: folder.name, name: person.name }),
    cancelLabel: copy("album.hand_over_stay"),
    confirmLabel: copy("album.hand_over_confirm"),
    tone: "danger",
  });
  if (ok) folders.handOver(folder.id, folder.name, person.key, person.name);
}

/** Restore redraws the page; the new More options button is not focusable at once, so retry for a few seconds. */
let refocusMenuUntil = 0;
const refocusWindowMs = 5000;
const refocusEveryMs = 50;

function tryRefocus(el: HTMLElement) {
  if (Date.now() > refocusMenuUntil || !el.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  el.focus();
  if (document.activeElement !== el) setTimeout(() => tryRefocus(el), refocusEveryMs);
}

// One stable callback: lit calls it only when the button is created, not on every redraw.
const refocusMenu = ref((el) => {
  if (el instanceof HTMLElement) queueMicrotask(() => tryRefocus(el));
});

async function chooseAlbumAction(value: string, status: Status, people: readonly Person[]) {
  const { id, name, role } = status.folder;
  if (value === "archive") {
    folders.archive(id, name);
    return;
  }
  if (value === "restore") {
    refocusMenuUntil = Date.now() + refocusWindowMs;
    folders.restore(id, name);
    return;
  }
  if (value === "leave" && status.folder.notice?.kind === "removed") {
    const ok = await confirmAction({
      ...removedDeleteSheet(name, adminName(status)),
      tone: "danger",
    });
    if (ok) folders.leave(id, name, true);
    return;
  }
  if (value === "leave" && role === "creator") {
    await handOverAlbum(status, people);
    return;
  }
  if (value === "leave") {
    const g = galleryViewModel(galleryActor.snapshot(), null);
    const mine = g.settled
      ? photosInScope(g.photos, { kind: "album", id }).filter((p) => p.mine)
      : undefined;
    const ok = await confirmAction({
      title: copy("album.leave", { name }),
      detail: leaveDetail({
        role: role === "member" ? "member" : "reader",
        adminName: adminName(status),
        mine,
        people,
      }),
      confirmLabel: copy("album.leave_2"),
      tone: "danger",
    });
    if (ok) folders.leave(id, name);
    return;
  }
  if (value === "delete") {
    const others = people.filter((p) => !p.you);
    const sheet = deleteSheet(name, status.photos, others);
    const ok = await confirmAction({
      ...sheet,
      confirmLabel: copy("album.delete_album"),
      tone: "danger",
    });
    if (ok) folders.delete(id, name);
  }
}

function albumMenu(status: Status, people: readonly Person[], busy: boolean, archived: boolean) {
  const items = albumMenuItems(
    status.folder.role,
    Boolean(status.folder.pending),
    status.folder.notice?.kind === "removed",
    {
      handing: Boolean(status.folder.handingOver),
      collaborators: handOverChoices(people).length,
    },
    archived,
    status.folder.name,
  );
  return html`<wa-dropdown
    placement="bottom-end"
    @wa-select=${(e: CustomEvent<{ item: { value: string } }>) =>
      void chooseAlbumAction(e.detail.item.value, status, people)}
  >
    <button
      slot="trigger"
      class="ui-icon-btn"
      aria-label=${copy("album.more_options")}
      ${refocusMenu}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="19" r="2" />
      </svg>
    </button>
    ${items.map(
      (item) =>
        html`<wa-dropdown-item
          value=${item.value}
          variant=${item.danger ? "danger" : "default"}
          ?disabled=${busy}
          >${item.label}${
            item.hint
              ? html`<span class="block max-w-64 text-xs text-muted">${item.hint}</span>`
              : null
          }</wa-dropdown-item
        >`,
    )}
  </wa-dropdown>`;
}

type PeopleVm = ReturnType<typeof peopleViewModel>;
type Status = NonNullable<ReturnType<typeof syncViewModel>["status"]>;

const memberNames = new Map<string, string>();
const removedPeople = new Map<
  string,
  { name: string; album: string; folderId: string; code: string }
>();

onOutput(peopleActor, (e) => {
  if (e.type !== "viewerLetAddPhotos" && e.type !== "VIEWER_LET_ADD_PHOTOS") return;
  const key = (e.payload as { memberKey: string }).memberKey;
  toast(copy("album.can_add_photos_now", { name: memberNames.get(key) ?? copy("album.they") }));
  memberNames.delete(key);
});

onOutput(peopleActor, (e) => {
  if (e.type !== "memberMadeViewer" && e.type !== "MEMBER_MADE_VIEWER") return;
  const key = (e.payload as { memberKey: string }).memberKey;
  const name = memberNames.get(key);
  toast(name ? copy("album.is_a_viewer_now", { name }) : copy("album.they_re_a_viewer_now"));
  memberNames.delete(key);
});

onOutput(peopleActor, (e) => {
  if (e.type !== "inviteWithdrawn" && e.type !== "INVITE_WITHDRAWN") return;
  const name = (e.payload as { name: string }).name;
  toast(
    name ? copy("invite.took_back_name_s_invite", { name }) : copy("invite.took_back_the_invite"),
  );
});

onOutput(peopleActor, (e) => {
  if (e.type !== "memberRemoved" && e.type !== "MEMBER_REMOVED") return;
  const key = (e.payload as { memberKey: string }).memberKey;
  const removed = removedPeople.get(key);
  removedPeople.delete(key);
  if (!removed) return;
  inviteLink.linkReplaced(removed.folderId, removed.code, removed.name);
  toast(copy("album.is_no_longer_in", { name: removed.name, album: removed.album }), {
    action: { label: copy("album.copy_new_link"), run: () => void copyNewLink(removed.folderId) },
  });
});

/** Reads the album at tap time, so the link is made with the refreshed code. */
async function copyNewLink(folderId: string) {
  const status = syncViewModel(syncActor.snapshot()).status;
  if (status?.folder.id !== folderId) {
    toast(copy("invite.couldn_t_copy_the_invite_2"));
    return;
  }
  await copyInviteLink(status.folder, status.name);
}

/** The toast when Decline is tapped: who was declined, with Undo until it closes. */
export function declinedToast(requesterName: string): string {
  return requesterName && requesterName !== copy("requests.they")
    ? copy("album.declined", { requesterName })
    : copy("album.declined_unnamed");
}

/** After Accept the card leaves and the new row can sit below the fold: bring the row to the middle of the screen and focus it. The row can arrive after the answer, so wait for it. */
export function revealMember(key: string, tries = 60): void {
  const row = [...document.querySelectorAll<HTMLElement>("[data-member-key]")].find(
    (el) => el.dataset.memberKey === key,
  );
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) setTimeout(() => revealMember(key, tries - 1), 100);
}

/** The one toast after Accept all: how many are in. */
export function acceptAllToast(count: number): string {
  return count === 1
    ? copy("album.1_person_is_in_as")
    : copy("album.people_are_in_as_viewers", { count });
}

onOutput(requestsActor, (e) => {
  if (e.type === allAcceptedAsViewers.type) {
    toast(acceptAllToast((e.payload as { count: number }).count));
    return;
  }
  if (e.type === declineHeld.type) {
    const { folderId, requesterKey, requesterName } = e.payload as {
      folderId: string;
      requesterKey: string;
      requesterName: string;
    };
    toast(declinedToast(requesterName), {
      action: {
        label: copy("albums.undo"),
        run: () => requests.undoDecline(folderId, requesterKey),
      },
      onClose: () => void requests.sendDecline(folderId, requesterKey),
    });
    return;
  }
  if (e.type === declineNotSent.type) {
    const { requesterName } = e.payload as { requesterName: string };
    toast(
      copy("album.couldn_t_send_your_no", {
        requesterName: requesterName || copy("requests.them"),
      }),
    );
    return;
  }
  if (e.type === requestCancelledBeforeAnswer.type) {
    const { requesterName } = e.payload as { requesterName: string };
    toast(copy("album.cancelled_this_request", { requesterName }));
    return;
  }
  if (e.type !== answerSent.type) return;
  const a = e.payload as { requesterKey: string; requesterName: string; approve: boolean };
  if (!a.approve) toast(declinedToast(a.requesterName));
});

/** The Remove confirm text. A Viewer added no photos, so that clause is dropped. */
export function removeDetail(name: string, viewer: boolean): string {
  const added = viewer ? "" : copy("album.and_the_photos_added_leave", { name });
  return copy("album.won_t_see_photos_added", { name, added });
}

/** The words under an Admin's name: who left and handed the album on when it was handed on, else the plain role. */
export function adminLineText(p: Pick<Person, "handedBy" | "name">, album: string) {
  if (p.handedBy === undefined) return t("member.role_admin");
  return t("member.handed_to", { fromName: p.handedBy, album, name: p.name });
}

function memberLine(p: PeopleVm["people"][number], album: string) {
  switch (p.role) {
    case "admin":
      return html`<p class="text-xs text-muted">${adminLineText(p, album)}</p>`;
    case "collaborator":
      return html`<p class="text-xs text-muted">${t("member.role_collaborator")}</p>`;
    case "viewer":
      return html`<p class="text-xs text-muted">${t("member.role_viewer")}</p>`;
    case "waiting":
      return html`<p class="text-xs text-muted">${t("member.waiting_for_admin")}</p>`;
  }
}

/** Ada's line while Summer is being handed to Ben: it ends when his phone is on, and Stay Admin calls it off until Ben's phone has confirmed. */
export function handingLine(folder: Pick<FolderSummary, "id" | "name" | "handingOver">) {
  const h = folder.handingOver;
  if (!h) return null;
  return html`<div
    class="flex items-center gap-3 rounded-xl bg-subtle px-4 py-2.5 ring-1 ring-trust-amber/40"
  >
    <p class="min-w-0 flex-1 text-sm text-fg" role="status">
      ${copy("album.handing_over", { album: folder.name, name: h.name })}
    </p>
    ${
      h.final
        ? null
        : html`<button
            class="ui-btn-ghost shrink-0"
            @click=${() => {
              folders.stayAdmin(folder.id, folder.name);
              document
                .querySelector<HTMLElement>(`[aria-label="${copy("album.more_options")}"]`)
                ?.focus();
            }}
          >
            ${t("album.hand_over_stay")}
          </button>`
    }
  </div>`;
}

export function roleCaption(folder: Pick<FolderSummary, "role" | "pending" | "notice">) {
  if (folder.pending || folder.notice?.kind === "removed") return null;
  switch (folder.role) {
    case "creator":
      return html`<p class="text-sm text-muted">${t("album.you_re_the_admin_you_add")}</p>`;
    case "member":
      return html`<p class="text-sm text-muted">${t("album.you_can_add_photos")}</p>`;
    case "reader":
      return html`<p class="text-sm text-muted">${t("album.you_can_see_every_photo")}</p>`;
  }
}

function memberRow(
  vm: PeopleVm,
  p: PeopleVm["people"][number],
  holding: MemberHolding | undefined,
) {
  const photosLine = memberPhotosLine(holding);
  const identity = p.identity;
  const dot = presenceDot({
    tone: p.connected ? "green" : "neutral",
    label: p.presence,
    size: "md",
    class: "shrink-0",
  });
  const tappable = p.tappable && !p.you && identity !== undefined;
  const body = html`${memberBadge(p.name, p.color)}
    <div class="min-w-0 flex-1">
      <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
        <span class="truncate">${p.name}${p.you ? copy("album.you") : ""}</span>
        ${p.you ? null : p.showPresence ? html`<span aria-hidden="true">${dot}</span>` : dot}
        ${p.friend ? html`<span class="shrink-0 text-xs font-normal text-muted">${t("album.friend")}</span>` : null}
      </p>
      ${memberLine(p, vm.folder?.name ?? "")}${photosLine === "" ? null : html`<p class="text-xs text-muted" data-member-photos>${photosLine}</p>`}${p.showPresence ? html`<p class="text-xs text-muted" data-member-presence>${p.presence}</p>` : null}
      ${
        p.clash
          ? html`<p class="truncate text-xs font-semibold text-warn-fg">
              ${t("album.not_your_friend", { clash: p.clash })}
            </p>`
          : null
      }
      ${
        p.friend && p.ownName !== p.name
          ? html`<p class="truncate text-xs text-muted">${p.ownName}</p>`
          : null
      }
      ${
        tappable && !p.friend
          ? html`<p class="truncate text-xs font-medium text-accent">
              ${t("friend_sheet.add_to_friends")} ›
            </p>`
          : null
      }
    </div>`;
  const handingKey = vm.folder?.handingOver?.key.toLowerCase();
  const controls = vm.isAdmin && !p.you && !p.admin && p.key.toLowerCase() !== handingKey;
  const roleButtonClass =
    "ui-btn-ghost min-w-0 flex-1 basis-40 justify-start text-left [overflow-wrap:anywhere]";
  return html`<li
    class="py-2 outline-none"
    data-motion-key=${p.key}
    data-member-key=${p.key}
    tabindex="-1"
  >
    ${
      tappable
        ? html`<button
            class="flex w-full min-w-0 items-center gap-3 text-left"
            @click=${(e: Event) => {
              rememberFocus(e.currentTarget as HTMLElement);
              friends.open({ identity, ownName: p.ownName });
            }}
          >
            ${body}
          </button>`
        : html`<div class="flex min-w-0 items-center gap-3">${body}</div>`
    }
    ${
      controls
        ? html`<div class="mt-2 flex flex-wrap gap-2 pl-12">
            ${
              p.viewer
                ? html`<button
                    class=${roleButtonClass}
                    ?disabled=${vm.busy}
                    @click=${() => {
                      if (!vm.folder) return;
                      memberNames.set(p.key, p.name);
                      people.letViewerAddPhotos(vm.folder.id, p.key);
                    }}
                  >
                    ${t("album.let_add_photos", { name: p.name })}
                  </button>`
                : html`<button
                    class=${roleButtonClass}
                    ?disabled=${vm.busy}
                    @click=${async () => {
                      const ok = await confirmAction({
                        title: copy("album.make_a_viewer_2", { name: p.name }),
                        detail: copy("album.keeps_seeing_every_photo_but", { name: p.name }),
                        confirmLabel: copy("album.make_viewer"),
                        cancelLabel: copy("album.keep_as_collaborator"),
                      });
                      if (ok && vm.folder) {
                        memberNames.set(p.key, p.name);
                        people.makeViewer(vm.folder.id, p.key);
                      }
                    }}
                  >
                    ${t("album.make_a_viewer", { name: p.name })}
                  </button>`
            }
            ${
              vm.folder && !vm.folder.handingOver
                ? html`<button
                    class=${roleButtonClass}
                    ?disabled=${vm.busy}
                    @click=${() => {
                      if (vm.folder) void confirmHandOver(vm.folder, p);
                    }}
                  >
                    ${t("album.hand_over_to", { album: vm.folder.name, name: p.name })}
                  </button>`
                : null
            }
            <button
              class="${roleButtonClass} text-danger-fg"
              ?disabled=${vm.busy}
              @click=${async () => {
                const ok = await confirmAction({
                  title: copy("album.remove", { name: p.name }),
                  detail: removeDetail(p.name, p.viewer === true),
                  confirmLabel: copy("album.remove_2"),
                  tone: "danger",
                });
                if (!ok || !vm.folder) return;
                removedPeople.set(p.key, {
                  name: p.name,
                  album: vm.folder.name,
                  folderId: vm.folder.id,
                  code: vm.folder.invite?.code ?? "",
                });
                people.remove(vm.folder.id, p.key);
              }}
            >
              ${t("album.remove_name", { name: p.name })}
            </button>
          </div>`
        : null
    }
  </li>`;
}

const requestKey = (r: { folderId: string; requesterKey: string }) =>
  `request:${r.folderId}/${r.requesterKey}`;

function inviteAccept(
  r: { folderId: string; requesterKey: string },
  busy: boolean,
  label: string,
  meaning: string,
  onClick: () => void,
  cls: string,
) {
  const descId = `${requestKey(r)}:${label}`;
  return html`<button class=${cls} aria-describedby=${descId} ?disabled=${busy} @click=${onClick}>
    <span class="flex w-full flex-col items-start text-left">
      <span>${label}</span>
      <span class="text-xs font-normal" id=${descId} aria-hidden="true">${meaning}</span>
    </span>
  </button>`;
}

/** A link's kind as it reads before "link": "the 1-day link". */
const LINK_KIND_WORD: Record<ValidFor, string> = {
  "10m": copy("link_kind.10_minute"),
  "1h": copy("link_kind.1_hour"),
  "1d": copy("link_kind.1_day"),
  "7d": copy("link_kind.7_day"),
};

/** "Asked 5 min ago", with which of the album's links it came through and when it was made, when the phone could tell. */
function askedLine(r: PeopleVm["requests"][number]): TemplateResult {
  const when = formatRelative(r.requestedAt);
  const kind = r.link ? linkKindOf(r.link) : undefined;
  if (!r.link || !kind) return t("album.asked", { when });
  return t("album.asked_with_link", {
    when,
    kind: LINK_KIND_WORD[kind],
    made: linkMadeText(r.link.madeAt),
  });
}

/** "You removed Bo this morning", or "Ada removed Bo on 12 Nov" when an earlier Admin did it. */
function removedLine(removed: { name: string; at: number; by?: string }): TemplateResult {
  const when = linkMadeText(removed.at);
  return removed.by === undefined
    ? t("album.removed_by_you", { name: removed.name, when })
    : t("album.removed_by", { by: removed.by, name: removed.name, when });
}

/** Who is asking: name, Friend tag, removed earlier, warning, real name, when, three words and declined earlier. The card and the sheet share it. */
export function requestIdentity(r: PeopleVm["requests"][number], joining: TemplateResult | null) {
  return html` <p class="text-sm text-fg">
      <span class="font-semibold">${r.name}</span>
      ${joining}${
        r.friend ? html`<span class="ml-1 text-xs text-muted">${t("album.friend")}</span>` : null
      }
    </p>
    ${r.removedEarlier ? html`<p class="text-xs font-semibold text-warn-fg">${removedLine(r.removedEarlier)}</p>` : null}
    ${r.sameNameIn ? html`<p class="text-xs font-semibold text-warn-fg">${t("album.same_name_in", { name: r.name, folderName: r.folderName, presence: r.sameNameIn })}</p>` : null}
    ${r.clash ? html`<p class="text-xs font-semibold text-warn-fg">${t("album.not_your_friend", { clash: r.clash })}</p>` : null}
    ${
      r.friend && r.requesterName !== r.name
        ? html`<p class="text-xs text-muted">${r.requesterName}</p>`
        : null
    }
    <p class="mt-1 text-xs text-muted">${askedLine(r)}</p>
    ${
      r.checkCode
        ? html`<p class="mt-2 text-xs text-muted">
            ${t("album.check_code")}
            <span class="block break-words text-lg font-semibold text-fg">${r.checkCode}</span>
          </p>`
        : null
    }
    ${r.declinedEarlier ? html`<p class="mt-1 text-xs font-semibold text-warn-fg">${t("album.declined_earlier")}</p>` : null}`;
}

/** Under the three words: what to check, or for a name clash, why to be careful. Nothing without words. */
function checkSentence(r: PeopleVm["requests"][number]) {
  if (!r.checkCode) return null;
  return html`<p class="mt-1 text-xs text-muted">
    ${r.clash ? t("people.someone_not_in_your_friends") : t("album.same_words_on_phone", { name: r.name })}
  </p>`;
}

function requestRow(r: PeopleVm["requests"][number], busy = false, failure: string | null = null) {
  const accept = (role: "reader" | "member") => () =>
    requests.respond(r.folderId, r.requesterKey, true, role);
  return html`<li class="ui-request-card" data-motion-key=${requestKey(r)}>
    ${requestIdentity(r, t("album.wants_to_join", { folderName: r.folderName }))}
    ${checkSentence(r)}
    ${
      r.viaInvite
        ? html`<div class="mt-2 flex flex-col gap-2">
            ${inviteAccept(
              r,
              busy,
              copy("album.accept_as_viewer"),
              copy("album.sees_every_photo_can_t"),
              accept("reader"),
              "ui-btn-primary w-full",
            )}
            ${inviteAccept(
              r,
              busy,
              copy("album.accept_as_collaborator"),
              copy("album.sees_every_photo_and_can"),
              accept("member"),
              "ui-btn-ghost w-full",
            )}
            <button
              class="ui-btn-ghost w-full"
              ?disabled=${busy}
              @click=${() => requests.holdDecline(r.folderId, r.requesterKey)}
            >
              ${t("album.decline")}
            </button>
          </div>`
        : html`<div class="mt-2 flex gap-2">
            <button
              class="ui-btn-ghost flex-1"
              ?disabled=${busy}
              @click=${() => requests.holdDecline(r.folderId, r.requesterKey)}
            >
              ${t("album.decline")}
            </button>
            <button class="ui-btn-primary flex-1" ?disabled=${busy} @click=${accept("member")}>
              ${t("album.accept")}
            </button>
          </div>`
    }
    ${failure ? html`<div class="mt-2">${errorBanner(failure, () => requests.retry())}</div>` : null}
  </li>`;
}

function requestsSection(vm: PeopleVm, id: string, reqVm: ReturnType<typeof requestsViewModel>) {
  if (vm.requests.length === 0) return null;
  const keys = viewerAcceptKeys(vm.requests, id);
  const hint = requestsHint(vm.requests);
  return html`<section
    class="ui-card border-l-4 border-l-warn p-5"
    data-motion-key="section:requests"
  >
    <h2 class="ui-label mb-3">${t("album.asking_to_join")}</h2>
    ${hint !== "" ? html`<p class="mb-3 text-xs text-muted">${hint}</p>` : null}
    <ul class="space-y-2" ${gridMotion({ keys: vm.requests.map(requestKey), settle: id })}>
      ${repeat(vm.requests, requestKey, (r) =>
        requestRow(
          r,
          reqVm.responding || reqVm.loading,
          reqVm.failedAnswer?.folderId === r.folderId &&
            reqVm.failedAnswer.requesterKey === r.requesterKey
            ? reqVm.error
            : null,
        ),
      )}
    </ul>
    ${
      keys.length >= 2
        ? html`<button
            class="ui-link mt-2 disabled:pointer-events-none disabled:opacity-50"
            data-accept-all
            ?disabled=${reqVm.responding || reqVm.loading}
            @click=${() => requests.acceptAllAsViewers(id, keys)}
          >
            ${t("album.accept_all_as_viewers", { count: keys.length })}
          </button>`
        : null
    }
  </section>`;
}

/** Accept removes the focused button: put focus on the card's link. */
function focusOnce(el: Element | undefined) {
  if (!(el instanceof HTMLElement)) return;
  queueMicrotask(() => el.focus({ preventScroll: true }));
}

/** After Accept: who is in, and a button to the photos. Primary only while no other request waits, so the page has one primary action. */
function acceptedCard(
  id: string,
  vm: PeopleVm,
  reqVm: ReturnType<typeof requestsViewModel>,
  friends: Record<string, string>,
) {
  const accepted = reqVm.accepted;
  if (accepted === null || accepted.folderId !== id) return null;
  const name = requestRowOf(accepted, friends).name;
  return keyed(
    accepted.requesterKey,
    html`<section class="ui-card p-5" data-motion-key="section:accepted">
      <p class="text-sm text-fg">${t("album.name_is_in", { name })}</p>
      <a
        ${ref(focusOnce)}
        class="${vm.requests.length > 0 ? "ui-btn-ghost" : "ui-btn-primary"} mt-3 inline-flex items-center"
        href="/albums/${encodeURIComponent(id)}"
        >${t("album.see_photos")}</a
      >
    </section>`,
  );
}

/** After Decline: who was turned down stays on the page after the toast goes, until the page changes. */
function declinedLines(reqVm: ReturnType<typeof requestsViewModel>) {
  if (reqVm.declined.length === 0) return null;
  return html`<div class="px-1 text-sm text-fg" data-declined-line>
    ${reqVm.declined.map((r) => html`<p>${declinedToast(r.requesterName)}</p>`)}
  </div>`;
}

function membersSection(vm: PeopleVm, id: string, holdings: Map<string, MemberHolding>) {
  return html`<section class="ui-card p-5" data-motion-key="section:members">
    <h2 class="ui-label">${t("album.members")}</h2>
    <p class="mb-2 mt-1 text-xs text-muted">${t("album.everyone_in_the_album_sees")}</p>
    ${vm.error ? html`<p class="mb-2 text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
    <ul
      class="divide-y divide-line"
      ${gridMotion({ keys: vm.people.map((p) => p.key), settle: id })}
    >
      ${repeat(
        vm.people,
        (p) => p.key,
        (p) => memberRow(vm, p, holdings.get(p.key)),
      )}
    </ul>
    <p class="mt-2 text-xs text-muted">${t("album.connected_means_they_have_justus")}</p>
  </section>`;
}

/** Enrolling by raw drive key: a troubleshooting path, so it lives under
 * Advanced; everyday approval goes through the requests above. */
function enrollSection(status: Status, settled: boolean, busy: boolean) {
  if (status.folder.role !== "creator") return null;
  return html`
    <section class="mt-5">
      <h3 class="text-sm font-semibold text-fg">${t("album.add_a_member_by_drive")}</h3>
      <p class="mb-3 mt-1 text-sm">${t("album.paste_a_device_s_drive")}</p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const form = e.target as HTMLFormElement;
          const key = (form.querySelector("[data-k]") as HTMLInputElement | null)?.value.trim();
          const name = (form.querySelector("[data-n]") as HTMLInputElement | null)?.value.trim();
          if (key && name) sync.enroll(key, name);
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder=${copy("album.device_drive_key_hex")}
          aria-label=${copy("album.device_drive_key")}
          data-k
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
        />
        <input
          class="ui-input w-full sm:w-40"
          placeholder=${copy("album.device_name")}
          aria-label=${copy("album.device_name_2")}
          data-n
        />
        <button class="ui-btn-ghost" type="submit" ?disabled=${busy || !settled}>
          ${t("album.enroll")}
        </button>
      </form>
    </section>
  `;
}

// A hypercore key is a read capability: whoever holds it can download and
// read that drive. The discovery key is a hash of it, only good for finding
// peers on the network.
function keyRow(name: string, value: string, about: string, secret = false) {
  return html`<div class="space-y-1">
    <dt class="text-sm text-fg">${name}</dt>
    <dd class="text-sm">${about}</dd>
    ${
      secret && value
        ? secretValue(name, value)
        : html`<dd class="break-all font-mono">${value || "—"}</dd>`
    }
  </div>`;
}

const eyeIcon = (off: boolean, cls: string) => html`<svg
  class=${cls}
  width="16"
  height="16"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
  <circle cx="12" cy="12" r="3" />
  ${off ? html`<path d="M3 3l18 18" />` : ""}
</svg>`;

// Hidden until asked, so the key isn't on screen for a screenshot or an
// onlooker. One checkbox toggle drives it via `group-has-[:checked]:`, not
// app state.
function secretValue(name: string, value: string) {
  return html`<dd class="group flex items-start gap-2">
    <span class="min-w-0 flex-1 font-mono group-has-[:checked]:hidden">••••••••••••••••</span>
    <span class="hidden min-w-0 flex-1 break-all font-mono group-has-[:checked]:block"
      >${value}</span
    >
    <label
      class="inline-flex shrink-0 cursor-pointer items-center rounded-md p-1 text-fg hover:bg-subtle has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
    >
      <input
        type="checkbox"
        class="sr-only"
        aria-label=${copy("album.show", { name: name.toLowerCase() })}
      />
      ${eyeIcon(true, "group-has-[:checked]:hidden")}
      ${eyeIcon(false, "hidden group-has-[:checked]:block")}
    </label>
  </dd>`;
}

function advancedSection(status: Status, settled: boolean, busy: boolean) {
  const driveKey = status.folder.driveKey || status.driveKey;
  return html`<details class="text-xs text-muted" data-motion-key="section:advanced">
    <summary class="ui-label cursor-pointer select-none">${t("album.advanced")}</summary>
    <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
      <dt class="text-muted">${t("album.peers_reachable")}</dt>
      <dd>${status.peers}</dd>
      <dt class="text-muted">${t("album.photos_2")}</dt>
      <dd>${status.photos}</dd>
      <dt class="text-muted">${t("album.members")}</dt>
      <dd>${status.members.length}</dd>
    </dl>
    <p class="mt-4 text-sm text-fg">${t("album.technical_keys_for_troubleshooting_do")}</p>
    <dl class="mt-3 space-y-4">
      ${keyRow(
        copy("album.discovery_key"),
        status.discoveryKey,
        copy("album.a_one_way_fingerprint_of"),
      )}
    </dl>
    <h3 class="mt-5 text-sm font-semibold text-danger-fg">${t("album.secret")}</h3>
    <p class="mt-1 text-sm">${t("album.anyone_with_one_of_these")}</p>
    <dl class="mt-3 space-y-4">
      ${keyRow(
        copy("album.share_key"),
        status.folder.shareKey,
        copy("album.the_album_s_invite_it"),
        true,
      )}
      ${keyRow(
        copy("album.your_drive_key"),
        driveKey,
        copy("album.where_this_device_keeps_the"),
        true,
      )}
    </dl>
    ${enrollSection(status, settled, busy)}
  </details>`;
}

function albumBody(
  id: string,
  vm: PeopleVm,
  syncVm: ReturnType<typeof syncViewModel>,
  friends: Record<string, string>,
  reqVm: ReturnType<typeof requestsViewModel>,
) {
  const { status, state, busy, settled, error, fatal } = syncVm;
  const back = html`<a class="text-sm text-muted hover:text-fg" href="/sharing"
    >${t("album.sharing")}</a
  >`;
  if (!status || status.folder.id !== id) {
    return html`<div class="max-w-2xl space-y-4">
      ${back}
      ${
        settled || state === "couldNotCheckAlbum" || fatal
          ? html`<p class="text-fg">${t("album.this_album_isn_t_showing")}</p>
              <button class="ui-btn-primary" @click=${() => folders.switchTo(id)}>
                ${t("album.open_album")}
              </button>`
          : html`<p class="text-muted">${t("album.loading")}</p>`
      }
    </div>`;
  }
  const removed = status.folder.notice?.kind === "removed";
  return html`<div
    class="contents"
    ${gridMotion({ keys: vm.requests.map(requestKey), settle: id })}
    ${arrivalFocusWithin(id)}
  >
    ${renderAlbumFull({
      back: copy("album.sharing"),
      name: status.folder.name,
      role: removed ? undefined : roleLabel(status.folder.role, status.folder.pending),
      menu: html`${watch(foldersActor, (fs) =>
        albumMenu(
          status,
          vm.people,
          !foldersViewModel(fs).settled,
          foldersViewModel(fs).archived.some((f) => f.id === id),
        ),
      )}`,
      about: html`${roleCaption(status.folder)}
      ${albumNotice(status.folder.notice, status.folder.name)} ${handingLine(status.folder)}`,
      actions: html`${watch(foldersActor, (fs) =>
        foldersViewModel(fs).archived.some((f) => f.id === id)
          ? null
          : html`<div class="flex flex-wrap items-center gap-2">
              ${
                !removed && planAdd(id, [status.folder], status).kind === "direct"
                  ? addPhotosButton(id)
                  : null
              }
              <a class="ui-btn-ghost inline-flex items-center" href="/albums/${id}"
                >${t("album.see_photos_in_this_album")}</a
              >
            </div>`,
      )}`,
      problem: html`${errorBanner(
        error,
        state === "couldNotCheckAlbum" && !fatal ? () => sync.retry() : undefined,
        fatal ? () => window.location.reload() : undefined,
      )}`,
      requests: html`${requestsSection(vm, id, reqVm)}${acceptedCard(id, vm, reqVm, friends)}${declinedLines(reqVm)}`,
      invite: html`<div data-motion-key="section:invite">
        ${invitePanel(
          status.folder,
          status.name,
          adminName(status),
          vm.qrShown,
          () => people.showQr(),
          status.members.flatMap((m) => (m.identity ? [m.identity] : [])),
          friends,
          vm.busy,
          vm.takeBackError,
        )}
      </div>`,
      members: html`${removed ? null : watch(galleryActor, (g) => membersSection(vm, id, memberHoldings(photosInScope(galleryViewModel(g, null).photos, { kind: "album", id }), vm.people)))}`,
      advanced: html`${advancedSection(status, settled, busy)}`,
      sheets: html`${friendSheetView()} ${addFriendSheetView()}
      ${acceptAllSheetView(vm.requests, id, reqVm.acceptAllSheet)}`,
    })}
  </div>`;
}

/** Add photos: pick for this album, then open it to watch them arrive. Disabled while the
 * gallery can't take a pick, as on the photos page. */
function addPhotosButton(id: string) {
  const after = () => open(`/albums/${id}`);
  return html`${pickerInput(id, after)}${watch(galleryActor, (g) => {
    const vm = galleryViewModel(g, null);
    return html`<button
      class="ui-btn bg-action text-on-action"
      ?disabled=${!vm.settled}
      @click=${() => void startAdd(id, "library", after)}
    >
      ${t("album.add_photos")}
    </button>`;
  })}`;
}

/** Leaving the page with the Accept all sheet open closes it, so no other album is left with disabled buttons. */
onPageChange(() => {
  requests.forgetAccepted();
  if (requests.state() === "confirmingAcceptAll") requests.cancelAcceptAll();
});

export function albumView(id: string) {
  return watch(peopleActor, (ps) =>
    watch(syncActor, (ss) =>
      watch(requestsActor, (rs) =>
        watch(friendsActor, (fs) =>
          watch(presenceClockActor, (pc) => {
            const syncVm = syncViewModel(ss);
            const vm = peopleViewModel(ps, {
              status: syncVm.status,
              requests: rs.context.requests,
              friends: fs.context.friends,
              presence: pc.context,
            });
            return albumBody(id, vm, syncVm, fs.context.friends, requestsViewModel(rs));
          }),
        ),
      ),
    ),
  );
}
