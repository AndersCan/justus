import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { friends, friendsActor } from "../machines/friends-machine";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
import { people, peopleActor, peopleViewModel } from "../machines/people-machine";
import { requests, requestsActor, requestsViewModel } from "../machines/requests-machine";
import { sync, syncActor, syncViewModel } from "../machines/sync-machine";
import { friendlyError } from "../utils/friendly-error";
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

/** Why a Member or Viewer needs the Admin again after leaving. */
export function leaveDetail(role: "member" | "reader", adminName: string): string {
  return role === "member"
    ? `It disappears from this phone, along with the photos you added to it, and you drop off the people list. To come back you need a new invite from ${adminName}.`
    : `It disappears from this phone. To come back you need a new invite from ${adminName}.`;
}

const photoCount = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

/** The names after "will lose their photos in it": none past three others. */
function loseLine(names: string[]): string {
  if (names.length === 0 || names.length > 3) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return ` ${list} will lose their photos in it.`;
}

/** The delete sheet: with others it says whose photos go, alone it is just this phone. */
export function deleteSheet(name: string, photos: number, otherNames: string[]) {
  const count = photoCount(photos);
  if (otherNames.length === 0) {
    return {
      title: `Delete “${name}”?`,
      detail: `The album and its ${count} are removed from this phone. This can't be undone.`,
    };
  }
  return {
    title: `Delete “${name}” for everyone?`,
    detail: `The album and its ${count}, including the ones other people added, are removed from every member's phone. This can't be undone. Photos saved to a phone's camera roll are not touched.${loseLine(otherNames)}`,
  };
}

/** The ••• menu entries by role: everyone archives; the Admin deletes, others leave. */
export function albumMenuItems(
  role: "creator" | "member" | "reader",
  pending: boolean,
): { value: "archive" | "leave" | "delete"; label: string; danger: boolean }[] {
  const archive = { value: "archive", label: "Archive", danger: false } as const;
  if (pending) return [archive];
  if (role === "creator")
    return [archive, { value: "delete", label: "Delete album", danger: true }];
  return [archive, { value: "leave", label: "Leave album", danger: true }];
}

async function chooseAlbumAction(value: string, status: Status) {
  const { id, name, role } = status.folder;
  if (value === "archive") {
    folders.archive(id, name);
    return;
  }
  if (value === "leave") {
    const ok = await confirmAction({
      title: `Leave “${name}”?`,
      detail: leaveDetail(role === "member" ? "member" : "reader", adminName(status)),
      confirmLabel: "Leave",
      tone: "danger",
    });
    if (ok) folders.leave(id, name);
    return;
  }
  if (value === "delete") {
    const others = status.members.slice(1).map((m) => m.name);
    const sheet = deleteSheet(name, status.photos, others);
    const ok = await confirmAction({ ...sheet, confirmLabel: "Delete album", tone: "danger" });
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
      aria-label="More options"
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

const letNames = new Map<string, string>();

onOutput(peopleActor, (e) => {
  if (e.type !== "viewerLetAddPhotos" && e.type !== "VIEWER_LET_ADD_PHOTOS") return;
  const key = (e.payload as { memberKey: string }).memberKey;
  toast(`${letNames.get(key) ?? "They"} can add photos now`);
  letNames.delete(key);
});

function memberRow(vm: PeopleVm, p: PeopleVm["people"][number]) {
  const body = html`${avatarBadge(p.name)}
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-fg">
        ${p.name}${p.you ? " (you)" : ""}
        ${p.admin ? html`<span class="ml-1 text-xs font-normal text-muted">· Admin</span>` : null}
        ${p.viewer ? html`<span class="ml-1 text-xs font-normal text-muted">· Viewer</span>` : null}
        ${
          !p.admin && !p.viewer
            ? html`<span class="ml-1 text-xs font-normal text-muted">· Collaborator</span>`
            : null
        }
        ${p.friend ? html`<span class="ml-1 text-xs font-normal text-muted">· Friend</span>` : null}
      </p>
      ${
        p.friend && p.ownName !== p.name
          ? html`<p class="truncate text-xs text-muted">${p.ownName}</p>`
          : null
      }
      <p class="flex items-center gap-1.5 text-xs text-muted">
        ${
          p.viewer
            ? null
            : html`<span
                class="inline-block h-1.5 w-1.5 rounded-full ${p.connected ? "bg-ok" : "bg-line"}"
                aria-hidden="true"
              ></span>`
        }
        ${p.presence}
      </p>
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
            aria-label="Let ${p.name} add photos"
            ?disabled=${vm.busy}
            @click=${() => {
              if (!vm.folder) return;
              letNames.set(p.key, p.name);
              people.letViewerAddPhotos(vm.folder.id, p.key);
            }}
          >
            Let ${p.name} add photos
          </button>`
        : null
    }
    ${
      vm.isAdmin && !p.you && !p.admin && !p.viewer
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            aria-label="Make ${p.name} a Viewer"
            ?disabled=${vm.busy}
            @click=${async () => {
              const ok = await confirmAction({
                title: `Make ${p.name} a Viewer?`,
                detail: `${p.name} keeps seeing every photo but can't add more. The photos ${p.name} already added stay in the album.`,
                confirmLabel: "Make Viewer",
              });
              if (ok && vm.folder) people.makeViewer(vm.folder.id, p.key);
            }}
          >
            Make Viewer
          </button>`
        : null
    }
    ${
      vm.isAdmin && !p.you && !p.admin && !p.viewer
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-danger-fg hover:underline"
            ?disabled=${vm.busy}
            @click=${async () => {
              const ok = await confirmAction({
                title: `Remove ${p.name}?`,
                detail:
                  "They can no longer add photos. They keep what they already have, and can still see new photos if they kept the invite link. To shut someone out, start a new album.",
                confirmLabel: "Remove",
                tone: "danger",
              });
              if (ok && vm.folder) people.remove(vm.folder.id, p.key);
            }}
          >
            Remove
          </button>`
        : null
    }
  </li>`;
}

const requestKey = (r: { folderId: string; requesterKey: string }) =>
  `request:${r.folderId}/${r.requesterKey}`;

function requestRow(r: PeopleVm["requests"][number], busy = false) {
  const accept = (role: "reader" | "member", toastText: string) => () => {
    requests.respond(r.folderId, r.requesterKey, true, role);
    toast(toastText);
  };
  return html`<li class="rounded-xl bg-subtle p-3" data-motion-key=${requestKey(r)}>
    <p class="text-sm text-fg">
      <span class="font-semibold">${r.requesterName}</span> wants to join “${r.folderName}”
    </p>
    <p class="mt-1 text-xs text-muted">Asked ${formatRelative(r.requestedAt)}</p>
    ${
      r.viaInvite
        ? html`<p class="mt-1 text-xs text-muted">
            A Viewer sees every photo. A Collaborator can add photos too.
          </p>`
        : null
    }
    <div class="mt-2 flex gap-2">
      <button
        class="ui-btn-ghost"
        ?disabled=${busy}
        @click=${() => requests.respond(r.folderId, r.requesterKey, false)}
      >
        Decline
      </button>
      ${
        r.viaInvite
          ? html`<button
              class="ui-btn-primary"
              ?disabled=${busy}
              @click=${accept("reader", `${r.requesterName} is in as a Viewer`)}
            >
              Accept as Viewer
            </button>`
          : html`<button
              class="ui-btn-primary"
              ?disabled=${busy}
              @click=${accept("member", `${r.requesterName} is in`)}
            >
              Accept
            </button>`
      }
    </div>
    ${
      r.viaInvite
        ? html`<button
            class="mt-2 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            ?disabled=${busy}
            @click=${accept("member", `${r.requesterName} is in and can add photos`)}
          >
            Accept, and let them add photos
          </button>`
        : null
    }
  </li>`;
}

function requestsSection(vm: PeopleVm, id: string) {
  if (vm.requests.length === 0) return null;
  return html`<section
    class="ui-card border-l-4 border-l-warn p-5"
    data-motion-key="section:requests"
  >
    <h2 class="ui-label mb-3">Asking to join</h2>
    <ul class="space-y-2" ${gridMotion({ keys: vm.requests.map(requestKey), settle: id })}>
      ${repeat(vm.requests, requestKey, (r) =>
        requestRow(r, requestsViewModel(requestsActor.snapshot()).responding),
      )}
    </ul>
  </section>`;
}

function membersSection(vm: PeopleVm, id: string) {
  return html`<section class="ui-card p-5" data-motion-key="section:members">
    <h2 class="ui-label">Members</h2>
    <p class="mb-2 mt-1 text-xs text-muted">
      Connected means they have Justus open and your phone can reach them right now. Everyone in the
      album sees this list. Viewers see every photo but can't add any.
    </p>
    ${vm.error ? html`<p class="mb-2 text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
    <ul
      class="divide-y divide-line"
      ${gridMotion({ keys: vm.people.map((p) => p.key), settle: id })}
    >
      ${repeat(
        vm.people,
        (p) => p.key,
        (p) => memberRow(vm, p),
      )}
    </ul>
  </section>`;
}

/** Enrolling by raw drive key: a troubleshooting path, so it lives under
 * Advanced; everyday approval goes through the requests above. */
function enrollSection(status: Status, settled: boolean, busy: boolean) {
  if (status.folder.role !== "creator") return null;
  return html`
    <section class="mt-5">
      <h3 class="text-sm font-semibold text-fg">Add a member by drive key</h3>
      <p class="mb-3 mt-1 text-sm">
        Paste a device's drive key and a name to let it add photos without a request.
      </p>
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
          placeholder="device drive key (hex)"
          aria-label="Device drive key"
          data-k
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
        />
        <input
          class="ui-input w-full sm:w-40"
          placeholder="device name"
          aria-label="Device name"
          data-n
        />
        <button class="ui-btn-ghost" type="submit" ?disabled=${busy || !settled}>Enroll</button>
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
      <input type="checkbox" class="sr-only" aria-label="Show ${name.toLowerCase()}" />
      ${eyeIcon(true, "group-has-[:checked]:hidden")}
      ${eyeIcon(false, "hidden group-has-[:checked]:block")}
    </label>
  </dd>`;
}

function advancedSection(status: Status, settled: boolean, busy: boolean) {
  const driveKey = status.folder.driveKey || status.driveKey;
  return html`<details class="text-xs text-muted" data-motion-key="section:advanced">
    <summary class="ui-label cursor-pointer select-none">Advanced</summary>
    <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
      <dt class="text-muted">Peers reachable</dt>
      <dd>${status.peers}</dd>
      <dt class="text-muted">Photos</dt>
      <dd>${status.photos}</dd>
      <dt class="text-muted">Members</dt>
      <dd>${status.members.length}</dd>
    </dl>
    <p class="mt-4 text-sm text-fg">
      Technical keys for troubleshooting. Do not share them unless you know what you are doing.
    </p>
    <dl class="mt-3 space-y-4">
      ${keyRow(
        "Discovery key",
        status.discoveryKey,
        "A one-way fingerprint of your drive key that devices use to find each other. It opens no photos, though someone holding it could see which network addresses are syncing this album.",
      )}
    </dl>
    <h3 class="mt-5 text-sm font-semibold text-danger-fg">Secret</h3>
    <p class="mt-1 text-sm">
      Anyone with one of these can see the photos, and they can't be changed.
    </p>
    <dl class="mt-3 space-y-4">
      ${keyRow(
        "Share key",
        status.folder.shareKey,
        "The album's invite. It opens the whole album: every member's photos and the member list.",
        true,
      )}
      ${keyRow(
        "Your drive key",
        driveKey,
        "Where this device keeps the photos it added to this album. The Admin needs it to enroll you as a member.",
        true,
      )}
    </dl>
    ${enrollSection(status, settled, busy)}
  </details>`;
}

function albumBody(id: string, vm: PeopleVm, syncVm: ReturnType<typeof syncViewModel>) {
  const { status, state, busy, settled, error, fatal } = syncVm;
  const back = html`<a class="text-sm text-muted hover:text-fg" href="/sharing">← Sharing</a>`;
  if (!status || status.folder.id !== id) {
    return html`<div class="max-w-2xl space-y-4">
      ${back}
      ${
        settled || state === "couldNotCheckAlbum" || fatal
          ? html`<p class="text-fg">This album isn't showing right now.</p>
              <button class="ui-btn-primary" @click=${() => folders.switchTo(id)}>
                Open album
              </button>`
          : html`<p class="text-muted">Loading…</p>`
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
        <span class="rounded-full bg-subtle px-2.5 py-1 text-xs font-semibold text-fg">
          ${roleLabel(status.folder.role, status.folder.pending)}
        </span>
        ${watch(foldersActor, (fs) => albumMenu(status, foldersViewModel(fs).busy))}
      </div>
    </div>
    ${albumNotice(status.folder.notice)}
    <a class="ui-btn-ghost inline-flex items-center" href="/albums/${id}"
      >See photos in this album</a
    >
    ${errorBanner(
      error,
      state === "couldNotCheckAlbum" && !fatal ? () => sync.retry() : undefined,
      fatal ? () => window.location.reload() : undefined,
    )}
    ${requestsSection(vm, id)}
    <div data-motion-key="section:invite">
      ${invitePanel(
        status.folder,
        status.name,
        adminName(status),
        vm.qrShown,
        () => people.showQr(),
        status.members.flatMap((m) => (m.identity ? [m.identity] : [])),
      )}
    </div>
    ${membersSection(vm, id)} ${advancedSection(status, settled, busy)} ${friendSheetView()}
    ${addFriendSheetView()}
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
          return albumBody(id, vm, syncVm);
        }),
      ),
    ),
  );
}
