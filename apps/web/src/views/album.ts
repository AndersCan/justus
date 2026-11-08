import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { friends, friendsActor } from "../machines/friends-machine";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
import { people, peopleActor, peopleViewModel } from "../machines/people-machine";
import {
  acceptAllKeys,
  allAccepted,
  answerSent,
  requests,
  requestsActor,
  requestsViewModel,
} from "../machines/requests-machine";
import { galleryActor, galleryViewModel } from "../machines/gallery-machine";
import { sync, syncActor, syncViewModel } from "../machines/sync-machine";
import { friendlyError } from "../utils/friendly-error";
import { albumHolding, holdingLine, type AlbumHolding } from "../utils/holding";
import { requestsHint } from "../utils/people";
import { formatRelative } from "../utils/time";
import { avatarBadge } from "./avatar";
import { roleLabel } from "./albums";
import { confirmAction } from "./confirm";
import { errorBanner } from "./error-banner";
import { adminName, invitePanel } from "./invite";
import { albumNotice } from "./notices";
import { addFriendSheetView } from "./add-friend-sheet";
import { friendSheetView, rememberFocus } from "./friend-sheet";
import { toast } from "./toast";
import { gridMotion } from "./grid-motion";

import { copy, t } from "../copy/copy";
/** Why a Member or Viewer needs the Admin again after leaving. */
export function leaveDetail(role: "member" | "reader", adminName: string): string {
  return role === "member"
    ? copy("album.it_disappears_from_this_phone", { adminName })
    : copy("album.it_disappears_from_this_phone_2", { adminName });
}

const photoCount = (n: number) => (n === 1 ? copy("album.1_photo") : copy("album.photos", { n }));

/** The names after "will lose their photos in it": none past three others. */
function loseLine(names: string[]): string {
  if (names.length === 0 || names.length > 3) return "";
  const list =
    names.length === 1
      ? names[0]
      : copy("album.and", { others: names.slice(0, -1).join(", "), last: names[names.length - 1] });
  return copy("album.will_lose_their_photos_in", { list });
}

/** The delete sheet: with others it says whose photos go, alone it is just this phone. */
export function deleteSheet(name: string, photos: number, otherNames: string[]) {
  const count = photoCount(photos);
  if (otherNames.length === 0) {
    return {
      title: copy("album.delete", { name }),
      detail: copy("album.the_album_and_its_are", { count }),
    };
  }
  return {
    title: copy("album.delete_for_everyone", { name }),
    detail: copy("album.the_album_and_its_including", { count, loseLine: loseLine(otherNames) }),
  };
}

/** The ••• menu entries by role: everyone archives; the Admin deletes, others leave. */
export function albumMenuItems(
  role: "creator" | "member" | "reader",
  pending: boolean,
): { value: "archive" | "leave" | "delete"; label: string; danger: boolean }[] {
  const archive = { value: "archive", label: copy("album.archive"), danger: false } as const;
  if (pending) return [archive];
  if (role === "creator")
    return [archive, { value: "delete", label: copy("album.delete_album"), danger: true }];
  return [archive, { value: "leave", label: copy("album.leave_album"), danger: true }];
}

async function chooseAlbumAction(value: string, status: Status) {
  const { id, name, role } = status.folder;
  if (value === "archive") {
    folders.archive(id, name);
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
    const others = status.members.slice(1).map((m) => m.name);
    const sheet = deleteSheet(name, status.photos, others);
    const ok = await confirmAction({
      ...sheet,
      confirmLabel: copy("album.delete_album"),
      tone: "danger",
    });
    if (ok) folders.delete(id, name);
  }
}

function albumMenu(status: Status, busy: boolean) {
  const items = albumMenuItems(status.folder.role, Boolean(status.folder.pending));
  return html`<wa-dropdown
    placement="bottom-end"
    @wa-select=${(e: CustomEvent<{ item: { value: string } }>) =>
      void chooseAlbumAction(e.detail.item.value, status)}
  >
    <button
      slot="trigger"
      class="ui-focus flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-subtle"
      aria-label=${copy("album.more_options")}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="12" r="2" />
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

/** The toast after an answer went through; a No gets none. */
export function answerToast(a: {
  requesterName: string;
  approve: boolean;
  role: "reader" | "member";
  viaInvite: boolean;
}): string {
  if (!a.approve) return "";
  if (a.role === "reader")
    return copy("album.is_in_as_a_viewer", { requesterName: a.requesterName });
  return a.viaInvite
    ? copy("album.is_in_as_a_collaborator", { requesterName: a.requesterName })
    : copy("album.is_in", { requesterName: a.requesterName });
}

/** The one toast after Accept all: how many are in, and as what. */
export function acceptAllToast(count: number, role: "reader" | "member"): string {
  if (role === "member") {
    return count === 1
      ? copy("album.1_person_is_in_as_collaborator")
      : copy("album.people_are_in_as_collaborators", { count });
  }
  return count === 1
    ? copy("album.1_person_is_in_as")
    : copy("album.people_are_in_as_viewers", { count });
}

onOutput(requestsActor, (e) => {
  if (e.type === allAccepted.type) {
    const p = e.payload as { count: number; role: "reader" | "member" };
    toast(acceptAllToast(p.count, p.role));
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

function memberRow(vm: PeopleVm, p: PeopleVm["people"][number], holding: AlbumHolding) {
  const line = holdingLine(
    p.you ? { kind: "count", held: holding.you } : holding.byKey.get(p.key),
    holding.total,
  );
  const body = html`${avatarBadge(p.name)}
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-fg">
        ${p.name}${p.you ? copy("album.you") : ""}
        ${p.admin ? html`<span class="ml-1 text-xs font-normal text-muted">${t("album.admin")}</span>` : null}
        ${p.viewer ? html`<span class="ml-1 text-xs font-normal text-muted">${t("album.viewer")}</span>` : null}
        ${
          !p.admin && !p.viewer
            ? html`<span class="ml-1 text-xs font-normal text-muted"
                >${t("album.collaborator")}</span
              >`
            : null
        }
        ${p.friend ? html`<span class="ml-1 text-xs font-normal text-muted">${t("album.friend")}</span>` : null}
      </p>
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
      ${line === undefined ? null : html`<p class="truncate text-xs text-muted">${line}</p>`}
    </div>`;
  const identity = p.identity;
  return html`<li class="flex items-center gap-3 py-2" data-motion-key=${p.key}>
    ${
      p.tappable && identity !== undefined
        ? html`<button
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            @click=${(e: Event) => {
              rememberFocus(e.currentTarget as HTMLElement);
              friends.open({ identity, ownName: p.ownName });
            }}
          >
            ${body}
          </button>`
        : html`<div class="flex min-w-0 flex-1 items-center gap-3">${body}</div>`
    }
    ${
      vm.isAdmin && !p.you && !p.admin && p.viewer
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            aria-label=${copy("album.let_add_photos", { name: p.name })}
            ?disabled=${vm.busy}
            @click=${() => {
              if (!vm.folder) return;
              memberNames.set(p.key, p.name);
              people.letViewerAddPhotos(vm.folder.id, p.key);
            }}
          >
            ${t("album.let_add_photos", { name: p.name })}
          </button>`
        : null
    }
    ${
      vm.isAdmin && !p.you && !p.admin && !p.viewer
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            aria-label=${copy("album.make_a_viewer", { name: p.name })}
            ?disabled=${vm.busy}
            @click=${async () => {
              const ok = await confirmAction({
                title: copy("album.make_a_viewer_2", { name: p.name }),
                detail: copy("album.keeps_seeing_every_photo_but", { name: p.name }),
                confirmLabel: copy("album.make_viewer"),
              });
              if (ok && vm.folder) {
                memberNames.set(p.key, p.name);
                people.makeViewer(vm.folder.id, p.key);
              }
            }}
          >
            ${t("album.make_viewer")}
          </button>`
        : null
    }
    ${
      vm.isAdmin && !p.you && !p.admin
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-danger-fg hover:underline"
            ?disabled=${vm.busy}
            @click=${async () => {
              const ok = await confirmAction({
                title: copy("album.remove", { name: p.name }),
                detail: removeDetail(p.name, p.viewer === true),
                confirmLabel: copy("album.remove_2"),
                tone: "danger",
              });
              if (ok && vm.folder) people.remove(vm.folder.id, p.key);
            }}
          >
            ${t("album.remove_2")}
          </button>`
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
) {
  const descId = `${requestKey(r)}:${label}`;
  return html`<button
    class="ui-btn-primary w-full"
    aria-describedby=${descId}
    ?disabled=${busy}
    @click=${onClick}
  >
    <span class="flex w-full flex-col items-start text-left">
      <span>${label}</span>
      <span class="text-xs font-normal" id=${descId} aria-hidden="true">${meaning}</span>
    </span>
  </button>`;
}

function requestRow(r: PeopleVm["requests"][number], busy = false, failure: string | null = null) {
  const accept = (role: "reader" | "member") => () =>
    requests.respond(r.folderId, r.requesterKey, true, role);
  return html`<li class="rounded-xl bg-subtle p-3" data-motion-key=${requestKey(r)}>
    <p class="text-sm text-fg">
      <span class="font-semibold">${r.name}</span>
      ${t("album.wants_to_join", { folderName: r.folderName })}${
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
    ${
      r.viaInvite
        ? html`<div class="mt-2 flex flex-col gap-2">
            ${inviteAccept(
              r,
              busy,
              copy("album.accept_as_viewer"),
              copy("album.sees_every_photo_can_t"),
              accept("reader"),
            )}
            ${inviteAccept(
              r,
              busy,
              copy("album.accept_as_collaborator"),
              copy("album.sees_every_photo_and_can"),
              accept("member"),
            )}
            <button
              class="ui-btn-ghost w-full"
              ?disabled=${busy}
              @click=${() => requests.respond(r.folderId, r.requesterKey, false)}
            >
              ${t("album.decline")}
            </button>
          </div>`
        : html`<div class="mt-2 flex gap-2">
            <button
              class="ui-btn-ghost"
              ?disabled=${busy}
              @click=${() => requests.respond(r.folderId, r.requesterKey, false)}
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
  const keys = acceptAllKeys(vm.requests, id);
  const sheet = reqVm.acceptAll?.folderId === id ? reqVm.acceptAll : null;
  const hint = requestsHint(vm.requests);
  return html`<section
    class="ui-card border-l-4 border-l-warn p-5"
    data-motion-key="section:requests"
  >
    <h2 class="ui-label mb-3">${t("album.asking_to_join")}</h2>
    ${hint !== "" ? html`<p class="mb-3 text-xs text-muted">${hint}</p>` : null}
    ${sheet ? acceptAllSheet(vm, sheet) : null}
    ${
      !sheet && keys.length >= 2
        ? html`<div class="mb-3">
            <button
              class="ui-btn-primary w-full"
              ?disabled=${reqVm.responding || reqVm.loading}
              @click=${() => requests.reviewAcceptAll(id, keys)}
            >
              ${t("album.accept_all", { count: keys.length })}
            </button>
          </div>`
        : null
    }
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
  </section>`;
}

/** The Accept all sheet: every name it lets in, Viewers or Collaborators, then Let them in or Cancel. */
function acceptAllSheet(
  vm: PeopleVm,
  sheet: { requesterKeys: string[]; role: "reader" | "member" },
) {
  const names = sheet.requesterKeys.map(
    (k) => vm.requests.find((r) => r.requesterKey === k)?.requesterName ?? copy("requests.they"),
  );
  const pick = (role: "reader" | "member", label: unknown) =>
    html`<button
      class=${sheet.role === role ? "ui-btn-primary flex-1" : "ui-btn-ghost flex-1"}
      aria-pressed=${sheet.role === role ? "true" : "false"}
      @click=${() => requests.pickAcceptAllRole(role)}
    >
      ${label}
    </button>`;
  return html`<div class="mb-3 rounded border border-line p-3" role="group">
    <p class="mb-2 text-sm">${t("album.let_these_people_in", { count: names.length })}</p>
    <ul class="mb-3 text-sm text-muted">
      ${names.map((n) => html`<li>${n}</li>`)}
    </ul>
    <div class="mb-2 flex gap-2">
      ${pick("reader", t("album.as_viewers"))} ${pick("member", t("album.as_collaborators"))}
    </div>
    <p class="mb-3 text-xs text-muted">
      ${
        sheet.role === "reader"
          ? t("album.they_can_see_the_photos")
          : t("album.they_can_see_and_add_photos")
      }
    </p>
    <div class="flex gap-2">
      <button class="ui-btn-ghost flex-1" @click=${() => requests.cancelAcceptAll()}>
        ${t("album.cancel_accept_all")}
      </button>
      <button class="ui-btn-primary flex-1" @click=${() => requests.confirmAcceptAll()}>
        ${t("album.let_them_in")}
      </button>
    </div>
  </div>`;
}

const NO_HOLDING: AlbumHolding = { total: 0, you: 0, byKey: new Map() };

function membersSection(vm: PeopleVm, id: string) {
  return html`<section class="ui-card p-5" data-motion-key="section:members">
    <h2 class="ui-label">${t("album.members")}</h2>
    ${watch(galleryActor, (g) => {
      const { state, photos } = galleryViewModel(g, null);
      const loaded = state !== "photosNotLoaded" && state !== "couldNotLoadPhotos";
      const holding = loaded ? albumHolding(photos, id) : NO_HOLDING;
      return html`<p class="mb-2 mt-1 text-xs text-muted">
          ${t("album.connected_means_they_have_justus")}${
            holding.total > 0 ? html` ${t("album.a_phone_gets_a_photo_when")}` : null
          }
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
        </ul>`;
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
      <h1 class="min-w-0 truncate text-2xl font-semibold tracking-tight text-fg">
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
        ${watch(foldersActor, (fs) => albumMenu(status, !foldersViewModel(fs).settled))}
      </div>
    </div>
    ${albumNotice(status.folder.notice, status.folder.name)}
    <a class="ui-btn-ghost inline-flex items-center" href="/albums/${id}"
      >${t("album.see_photos_in_this_album")}</a
    >
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
      )}
    </div>
    ${status.folder.notice?.kind === "removed" ? null : membersSection(vm, id)}
    ${advancedSection(status, settled, busy)} ${friendSheetView()} ${addFriendSheetView()}
  </div>`;
}

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
