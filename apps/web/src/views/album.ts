import type { FolderSummary } from "@justus/core";
import { arrivalFocus } from "./arrival-focus";
import { html, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { friends, friendsActor } from "../machines/friends-machine";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
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
import { albumHolding, holdingLine, type AlbumHolding } from "../utils/holding";
import { nameList, requestsHint, type Person } from "../utils/people";
import { formatRelative } from "../utils/time";
import { memberBadge } from "./avatar";
import { roleLabel } from "./albums";
import { confirmAction } from "./confirm";
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
/** Why a Member or Viewer needs the Admin again after leaving. */
export function leaveDetail(role: "member" | "reader", adminName: string): string {
  return role === "member"
    ? copy("album.it_disappears_from_this_phone", { adminName })
    : copy("album.it_disappears_from_this_phone_2", { adminName });
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
): { value: "archive" | "leave" | "delete"; label: string; danger: boolean }[] {
  const archive = { value: "archive", label: copy("album.archive"), danger: false } as const;
  if (pending) return [archive];
  if (role === "creator")
    return [archive, { value: "delete", label: copy("album.delete_album"), danger: true }];
  if (removed)
    return [archive, { value: "leave", label: copy("album.delete_from_this_phone"), danger: true }];
  return [archive, { value: "leave", label: copy("album.leave_album"), danger: true }];
}

async function chooseAlbumAction(value: string, status: Status, people: readonly Person[]) {
  const { id, name, role } = status.folder;
  if (value === "archive") {
    folders.archive(id, name);
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
  if (value === "leave") {
    const ok = await confirmAction({
      title: copy("album.leave", { name }),
      detail: leaveDetail(role === "member" ? "member" : "reader", adminName(status)),
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

function albumMenu(status: Status, people: readonly Person[], busy: boolean) {
  const items = albumMenuItems(
    status.folder.role,
    Boolean(status.folder.pending),
    status.folder.notice?.kind === "removed",
  );
  return html`<wa-dropdown
    placement="bottom-end"
    @wa-select=${(e: CustomEvent<{ item: { value: string } }>) =>
      void chooseAlbumAction(e.detail.item.value, status, people)}
  >
    <button
      slot="trigger"
      class="ui-focus flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-subtle"
      aria-label=${copy("album.more_options")}
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
          >${item.label}</wa-dropdown-item
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

/** The toast after an answer went through: who is in and how, or who was declined. */
export function answerToast(a: {
  requesterName: string;
  approve: boolean;
  role: "reader" | "member";
  viaInvite: boolean;
}): string {
  if (!a.approve) return declinedToast(a.requesterName);
  if (a.role === "reader")
    return copy("album.is_in_as_a_viewer", { requesterName: a.requesterName });
  return a.viaInvite
    ? copy("album.is_in_as_a_collaborator", { requesterName: a.requesterName })
    : copy("album.is_in", { requesterName: a.requesterName });
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
  const text = answerToast(e.payload as Parameters<typeof answerToast>[0]);
  if (text) toast(text);
});

/** The Remove confirm text. A Viewer added no photos, so that clause is dropped. */
export function removeDetail(name: string, viewer: boolean): string {
  const added = viewer ? "" : copy("album.and_the_photos_added_leave", { name });
  return copy("album.won_t_see_photos_added", { name, added });
}

function memberLine(role: PeopleVm["people"][number]["role"], phone: string | undefined) {
  const tail = phone === undefined ? null : ` · ${phone}`;
  switch (role) {
    case "admin":
      return html`<p class="text-xs text-muted">${t("member.role_admin")}${tail}</p>`;
    case "collaborator":
      return html`<p class="text-xs text-muted">${t("member.role_collaborator")}${tail}</p>`;
    case "viewer":
      return html`<p class="text-xs text-muted">${t("member.role_viewer")}${tail}</p>`;
    case "waiting":
      return html`<p class="text-xs text-muted">${t("member.waiting_for_admin")}</p>`;
  }
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

function memberRow(vm: PeopleVm, p: PeopleVm["people"][number], holding: AlbumHolding) {
  const line = p.you ? undefined : holdingLine(holding.byKey.get(p.key), holding.total);
  const identity = p.identity;
  const tappable = p.tappable && !p.you && identity !== undefined;
  const body = html`${memberBadge(p.name, p.color)}
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-fg">
        ${p.name}${p.you ? copy("album.you") : ""}
        ${p.friend ? html`<span class="ml-1 text-xs font-normal text-muted">${t("album.friend")}</span>` : null}
      </p>
      ${memberLine(p.role, line)}
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
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full ${p.connected ? "bg-ok" : "bg-line"}"
          aria-hidden="true"
        ></span>
        ${p.presence}
      </p>
      ${
        tappable && !p.friend
          ? html`<p class="truncate text-xs font-medium text-accent">
              ${t("friend_sheet.add_to_friends")} ›
            </p>`
          : null
      }
    </div>`;
  const controls = vm.isAdmin && !p.you && !p.admin;
  const roleButtonClass =
    "ui-btn-ghost min-w-0 flex-1 basis-40 justify-start text-left [overflow-wrap:anywhere]";
  return html`<li class="py-2" data-motion-key=${p.key}>
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

/** Who is asking: name, Friend tag, warning, real name, when, check code and declined earlier. The card and the sheet share it. */
export function requestIdentity(r: PeopleVm["requests"][number], joining: TemplateResult | null) {
  return html` <p class="text-sm text-fg">
      <span class="font-semibold">${r.name}</span>
      ${joining}${
        r.friend ? html`<span class="ml-1 text-xs text-muted">${t("album.friend")}</span>` : null
      }
    </p>
    ${r.clash ? html`<p class="text-xs font-semibold text-warn-fg">${t("album.not_your_friend", { clash: r.clash })}</p>` : null}
    ${
      r.friend && r.requesterName !== r.name
        ? html`<p class="text-xs text-muted">${r.requesterName}</p>`
        : null
    }
    <p class="mt-1 text-xs text-muted">
      ${t("album.asked", { when: formatRelative(r.requestedAt) })}${
        r.checkCode
          ? html` ${t("album.check_code")}
              <span class="font-semibold text-fg">${r.checkCode}</span>`
          : ""
      }
    </p>
    ${r.declinedEarlier ? html`<p class="mt-1 text-xs font-semibold text-warn-fg">${t("album.declined_earlier")}</p>` : null}`;
}

function requestRow(r: PeopleVm["requests"][number], busy = false, failure: string | null = null) {
  const accept = (role: "reader" | "member") => () =>
    requests.respond(r.folderId, r.requesterKey, true, role);
  return html`<li class="rounded-xl bg-subtle p-3" data-motion-key=${requestKey(r)}>
    ${requestIdentity(r, t("album.wants_to_join", { folderName: r.folderName }))}
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
              class="ui-btn-ghost"
              ?disabled=${busy}
              @click=${() => requests.holdDecline(r.folderId, r.requesterKey)}
            >
              ${t("album.decline")}
            </button>
            <button class="ui-btn-primary" ?disabled=${busy} @click=${accept("member")}>
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
            class="ui-focus mt-2 inline-flex min-h-11 items-center rounded-md text-sm font-semibold text-accent underline underline-offset-2 hover:text-accent-strong disabled:pointer-events-none disabled:opacity-50"
            ?disabled=${reqVm.responding || reqVm.loading}
            @click=${() => requests.acceptAllAsViewers(id, keys)}
          >
            ${t("album.accept_all_as_viewers", { count: keys.length })}
          </button>`
        : null
    }
  </section>`;
}

const NO_HOLDING: AlbumHolding = { total: 0, byKey: new Map() };

function membersSection(vm: PeopleVm, id: string) {
  return html`<section class="ui-card p-5" data-motion-key="section:members">
    <h2 class="ui-label">${t("album.members")}</h2>
    ${watch(galleryActor, (g) => {
      const { state, photos } = galleryViewModel(g, null);
      const loaded = state !== "photosNotLoaded" && state !== "couldNotLoadPhotos";
      const holding = loaded ? albumHolding(photos, id) : NO_HOLDING;
      return html`<p class="mb-2 mt-1 text-xs text-muted">
          ${t("album.everyone_in_the_album_sees")}
        </p>
        ${vm.error ? html`<p class="mb-2 text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
        <ul
          class="divide-y divide-line"
          ${gridMotion({ keys: vm.people.map((p) => p.key), settle: id })}
        >
          ${repeat(
            vm.people,
            (p) => p.key,
            (p) => memberRow(vm, p, holding),
          )}
        </ul>
        <p class="mt-2 text-xs text-muted">${t("album.connected_means_they_have_justus")}</p>`;
    })}
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
  return html`<div
    class="max-w-2xl space-y-5"
    ${gridMotion({ keys: vm.requests.map(requestKey), settle: id })}
  >
    ${back}
    <div class="flex items-center justify-between gap-3">
      <h1
        class="min-w-0 truncate text-2xl font-semibold tracking-tight text-fg outline-none"
        tabindex="-1"
        ${arrivalFocus(id)}
      >
        ${status.folder.name}
      </h1>
      <div class="flex shrink-0 items-center gap-1">
        ${
          status.folder.notice?.kind === "removed"
            ? null
            : html`<span class="rounded-full bg-subtle px-2.5 py-1 text-xs font-semibold text-fg">
                ${roleLabel(status.folder.role, status.folder.pending)}
              </span>`
        }
        ${watch(foldersActor, (fs) => albumMenu(status, vm.people, !foldersViewModel(fs).settled))}
      </div>
    </div>
    ${roleCaption(status.folder)} ${albumNotice(status.folder.notice, status.folder.name)}
    <div class="flex flex-wrap items-center gap-2">
      ${
        status.folder.notice?.kind !== "removed" &&
        planAdd(id, [status.folder], status).kind === "direct"
          ? addPhotosButton(id)
          : null
      }
      <a class="ui-btn-ghost inline-flex items-center" href="/albums/${id}"
        >${t("album.see_photos_in_this_album")}</a
      >
    </div>
    ${errorBanner(
      error,
      state === "couldNotCheckAlbum" && !fatal ? () => sync.retry() : undefined,
      fatal ? () => window.location.reload() : undefined,
    )}
    ${requestsSection(vm, id, reqVm)}
    <div data-motion-key="section:invite">
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
    </div>
    ${status.folder.notice?.kind === "removed" ? null : membersSection(vm, id)}
    ${advancedSection(status, settled, busy)} ${friendSheetView()} ${addFriendSheetView()}
    ${acceptAllSheetView(vm.requests, id, reqVm.acceptAllSheet)}
  </div>`;
}

/** Add photos: pick for this album, then open it to watch them arrive. Disabled while the
 * gallery can't take a pick, as on the photos page. */
function addPhotosButton(id: string) {
  const after = () => open(`/albums/${id}`);
  return html`${pickerInput(id, after)}${watch(galleryActor, (g) => {
    const vm = galleryViewModel(g, null);
    return html`<button
      class="ui-btn-primary"
      ?disabled=${!vm.settled}
      @click=${() => void startAdd(id, "library", after)}
    >
      ${t("album.add_photos")}
    </button>`;
  })}`;
}

/** Leaving the page with the Accept all sheet open closes it, so no other album is left with disabled buttons. */
onPageChange(() => {
  if (requests.state() === "confirmingAcceptAll") requests.cancelAcceptAll();
});

export function albumView(id: string) {
  return watch(peopleActor, (ps) =>
    watch(syncActor, (ss) =>
      watch(requestsActor, (rs) =>
        watch(friendsActor, (fs) => {
          const syncVm = syncViewModel(ss);
          const vm = peopleViewModel(ps, {
            status: syncVm.status,
            requests: rs.context.requests,
            friends: fs.context.friends,
          });
          return albumBody(id, vm, syncVm, fs.context.friends, requestsViewModel(rs));
        }),
      ),
    ),
  );
}
