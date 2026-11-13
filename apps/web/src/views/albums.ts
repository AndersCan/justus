import { html } from "lit-html";
import { focusOnArrival } from "./arrival-focus";
import type { AskSummary, DeletedAlbum, FolderSummary, OfferSummary } from "@justus/core";
import { watch } from "@mantaq/lit";
import { onOutput } from "@mantaq/sugar";
import { repeat } from "lit-html/directives/repeat.js";
import {
  FOLDERS_STATES,
  folders,
  foldersActor,
  foldersViewModel,
} from "../machines/folders-machine";
import { SYNC_STATES, syncActor, syncViewModel } from "../machines/sync-machine";
import { join, joinActor, joinViewOf } from "../machines/sharing/join-request";
import { requests, requestsActor } from "../machines/requests-machine";
import { friendOffer, friendOfferActor } from "../machines/sharing/friend-offer";
import { friendsActor } from "../machines/friends-machine";
import { people } from "../machines/people-machine";
import { currentPage, onPageChange, open, type AppPage } from "../machines/router-machine";
import { onStateChange } from "../machines/actor-utils";
import { ownerShown, parseInviteLink } from "../utils/invite-link";
import { errorBanner } from "./error-banner";
import { gridMotion } from "./grid-motion";
import { deletedNoticeText } from "./notices";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
// A friend's invite opens the album once the Admin's phone lets this phone in;
// if it never does, the row goes back to Join and says why.
onOutput(friendOfferActor, (e) => {
  if (e.type === "openAlbum") open(`/albums/${(e.payload as { folderId: string }).folderId}`);
  if (e.type === "couldNotJoin") {
    const { albumName, ownerName } = e.payload as { albumName: string; ownerName: string };
    toast(copy("albums.couldn_t_join_needs_justus", { albumName, ownerName }));
  }
});

/** User-facing role words (CONTEXT.md "User-facing words"). A pending join is
 * a Reader in code, but to the user it is a request still waiting. */
export function roleLabel(role: FolderSummary["role"], pending = false): string {
  if (pending) return copy("albums.waiting_for_approval");
  if (role === "creator") return copy("albums.admin");
  if (role === "member") return copy("albums.collaborator");
  return copy("albums.viewer");
}

async function pasteKey(input: HTMLInputElement) {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text === "") {
      join.pasteFoundNothing();
      return;
    }
    input.value = text;
    input.dispatchEvent(new Event("input"));
  } catch {
    toast(copy("albums.couldn_t_read_the_clipboard"));
  }
}

// Refresh the request inbox when the album state turns over (a join or an
// approval can change pending requests). Push-driven refreshes are handled in
// handle-message.
let syncSeen = false;
onStateChange(syncActor, SYNC_STATES, () => {
  if (syncSeen) requests.refresh();
  syncSeen = true;
});

// A new album made in Sharing opens on its Invite & members page, ready to
// send its link; a failed create stays here with its error.
onStateChange(foldersActor, FOLDERS_STATES, (next, prev) => {
  const { error, activeId } = foldersActor.snapshot().context;
  if (
    prev === "creatingAlbum" &&
    next === "showingAlbums" &&
    !error &&
    currentPage()?.route === "sharing"
  ) {
    if (activeId) focusOnArrival(activeId);
    open(activeId ? `/sharing/${activeId}` : "/sharing");
  }
});

const changeVerbs = {
  archive: "archive",
  restore: "restore",
  leave: "leave",
  delete: "delete",
  dismiss: copy("albums.dismiss_the_notice_for"),
} as const;

// Archive, restore, leave and delete end with a toast; leaving the album page
// goes to Your albums. A failure toasts and the album stays where it was.
onStateChange(foldersActor, FOLDERS_STATES, (next, prev) => {
  const change = foldersActor.snapshot().context.pendingChange;
  if (!change) return;
  const { kind, folderId, name } = change;
  if (next === "couldNotChangeAlbum") {
    toast(copy("albums.couldn_t_try_again", { action: changeVerbs[kind], name }));
    return;
  }
  if (next !== "showingAlbums") return;
  if (prev === "archivingAlbum") {
    open("/sharing");
    toast(copy("albums.archived", { name }), {
      action: { label: copy("albums.undo"), run: () => folders.restore(folderId, name) },
    });
  }
  if (prev === "restoringAlbum") toast(copy("albums.is_back_in_your_albums", { name }));
  if (prev === "leavingAlbum") {
    open("/sharing");
    toast(leaveToast(change));
  }
  if (prev === "deletingAlbum") {
    open("/sharing");
    toast(copy("albums.deleted", { name }));
  }
});

/** What a finished leave says: a removed person deleted the album, anyone else left. */
export function leaveToast(change: { name: string; removed?: true }): string {
  return change.removed
    ? copy("albums.deleted_from_this_phone", { name: change.name })
    : copy("albums.you_left", { name: change.name });
}

/** True when the open page is an album that was listed before and is in no list now. */
export function albumVanished(
  before: ReadonlySet<string>,
  listedNow: readonly string[],
  pageAlbumId: string | null,
): boolean {
  return pageAlbumId !== null && before.has(pageAlbumId) && !listedNow.includes(pageAlbumId);
}

// An album can disappear under an open page (the Admin deleted it); the person
// lands on Your albums, where the notice explains.
let listedBefore = new Set<string>();
foldersActor.on("change", {
  fn: (snapshot) => {
    if (foldersViewModel(snapshot).state !== "showingAlbums") return;
    const { folders: shown, archived } = snapshot.context;
    const listedNow = [...shown, ...archived].map((f) => f.id);
    const page = currentPage();
    const pageAlbumId =
      page?.route === "photoAlbum" || page?.route === "album" ? page.params.id : null;
    const vanished = albumVanished(listedBefore, listedNow, pageAlbumId);
    listedBefore = new Set(listedNow);
    if (vanished) open("/sharing");
  },
});

/** Pages about one album (its photos, its people) make it the active album,
 * so presence, invite and requests describe the album on screen. */
function followRouteAlbum() {
  const page = currentPage();
  const id = page?.route === "photoAlbum" || page?.route === "album" ? page.params.id : null;
  const { activeId, folders: list } = foldersActor.snapshot().context;
  if (!id || id === activeId || !foldersViewModel(foldersActor.snapshot()).settled) return;
  if (list.some((f) => f.id === id)) folders.switchTo(id);
}
onStateChange(foldersActor, FOLDERS_STATES, followRouteAlbum);

// The album page is the people sheet's home: open/close its machine with the
// route, and keep the join-request inbox fresh on the sharing pages. It also
// runs for the page the app starts on (reload, opening an address).
function followPagePeople(page: AppPage | undefined, old: AppPage | undefined) {
  if (page?.route === "album" && old?.route === "album" && page.params.id !== old.params.id) {
    people.close();
  }
  if (page?.route === "album") people.open();
  else if (old?.route === "album") people.close();
  if (page?.route === "album" || page?.route === "sharing") requests.refresh();
  followRouteAlbum();
}
onPageChange(followPagePeople);
followPagePeople(currentPage(), undefined);

type FoldersViewModel = ReturnType<typeof foldersViewModel>;

/** "Admin · 3 members", one text node so it reads (and matches) as one line. */
export function roleAndCount(folder: FolderSummary): string {
  if (folder.notice?.kind === "removed") return copy("albums.no_longer_in_this_album");
  const count = copy("albums.member", { members: folder.members });
  return `${roleLabel(folder.role, folder.pending)} · ${count}`;
}

function albumRow(folder: FolderSummary) {
  return html`
    <li
      class="flex items-center gap-3 rounded-2xl border border-line p-4"
      data-motion-key=${"album:" + folder.id}
    >
      <a
        class="ui-focus min-w-0 flex-1"
        href="/sharing/${folder.id}"
        aria-label=${copy("albums.invite_members_of", { name: folder.name })}
      >
        <span class="block truncate text-lg font-medium text-fg">${folder.name}</span>
        <span
          class="mt-0.5 block text-xs ${folder.pending ? "font-semibold text-warn-fg" : "text-muted"}"
          >${roleAndCount(folder)}</span
        >
      </a>
      ${watch(requestsActor, (q) => {
        const waiting =
          folder.role === "creator"
            ? q.context.requests.filter((r) => r.folderId === folder.id).length
            : 0;
        return waiting > 0
          ? html`<span
              class="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-fill"
              aria-label=${copy("albums.waiting_for_approval_2", { waiting })}
              >${waiting}</span
            >`
          : null;
      })}
      <a
        class="ui-btn-ghost inline-flex shrink-0 items-center"
        href="/albums/${folder.id}"
        aria-label=${copy("albums.photos_in", { name: folder.name })}
        >${t("albums.photos")}</a
      >
      <span class="text-muted" aria-hidden="true">›</span>
    </li>
  `;
}

/** The Archived section: only when something is archived; the count adds the Admin's waiting requests. */
function archivedSection(view: FoldersViewModel) {
  if (view.archived.length === 0) return null;
  return watch(requestsActor, (q) => {
    const ids = new Set(view.archived.map((f) => f.id));
    const waiting = q.context.requests.filter((r) => ids.has(r.folderId)).length;
    return html`<details class="ui-card p-4" data-motion-key="section:archived">
      <summary class="ui-label cursor-pointer select-none">
        ${archivedSummary(view.archived.length, waiting)}
      </summary>
      <ul
        class="mt-3 space-y-3"
        aria-label=${copy("albums.archived_albums")}
        ${gridMotion({ keys: view.archived.map((f) => "archived:" + f.id), settle: "archived" })}
      >
        ${repeat(
          view.archived,
          (f) => f.id,
          (f) => html`<li
            class="flex items-center gap-3 rounded-2xl border border-line p-4"
            data-motion-key=${"archived:" + f.id}
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-lg font-medium text-fg">${f.name}</span>
              <span class="mt-0.5 block text-xs text-muted">${roleAndCount(f)}</span>
            </span>
            <button
              class="ui-btn-ghost shrink-0"
              aria-label=${copy("albums.restore", { name: f.name })}
              ?disabled=${!view.settled}
              @click=${() => folders.restore(f.id, f.name)}
            >
              ${t("albums.restore_2")}
            </button>
          </li>`,
        )}
      </ul>
    </details>`;
  });
}

/** "Archived (2)", with " · 1 waiting" when the Admin has requests on archived albums. */
export function archivedSummary(count: number, waiting: number): string {
  return copy("albums.archived_2", {
    count,
    note: waiting > 0 ? copy("albums.waiting", { waiting }) : "",
  });
}

/** One notice per album the Admin deleted, newest first, until dismissed. */
function deletedNotices(view: FoldersViewModel) {
  const newestFirst: DeletedAlbum[] = [...view.deleted].reverse();
  return repeat(
    newestFirst,
    (d) => d.id,
    (d) => html`<div
      data-motion-key=${"notice:" + d.id}
      class="flex items-center gap-3 rounded-xl bg-subtle px-4 py-2.5 ring-1 ring-trust-amber/40"
    >
      <p class="min-w-0 flex-1 text-sm text-fg" role="status">${deletedNoticeText(d)}</p>
      <button
        class="ui-btn-ghost shrink-0"
        aria-label=${copy("albums.dismiss_notice_about", { name: d.name })}
        ?disabled=${!view.settled}
        @click=${() => folders.dismissNotice(d.id, d.name)}
      >
        ${t("albums.dismiss")}
      </button>
    </div>`,
  );
}

function askRow(ask: AskSummary) {
  const label =
    ask.status === "declined"
      ? copy("albums.not_accepted")
      : ask.status === "linkOff"
        ? copy("albums.link_no_longer_works")
        : copy("albums.waiting_for_to_accept", { ownerName: ownerShown(ask.ownerName, "mid") });
  const muted = ask.status !== "waiting";
  return html`
    <li data-motion-key=${"ask:" + ask.code}>
      <button
        class="ui-focus flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left"
        aria-label="${label}: ${ask.albumName}"
        @click=${() => join.reopenRequest(ask)}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-lg font-medium text-fg">${ask.albumName}</span>
          <span class="mt-0.5 block text-xs ${muted ? "text-muted" : "font-semibold text-warn-fg"}"
            >${label}</span
          >
        </span>
        <span class="text-muted" aria-hidden="true">›</span>
      </button>
    </li>
  `;
}

function offerRow(offer: OfferSummary) {
  return watch(friendsActor, (f) => {
    const owner = f.context.friends[offer.owner] ?? offer.ownerName;
    return watch(friendOfferActor, (s) => {
      const joining = s.path[0] === "joiningFriendsAlbum";
      const current = (s.payload as { offer?: OfferSummary } | undefined)?.offer;
      const busy = joining && current?.code === offer.code && current.owner === offer.owner;
      return html`<li
        class="ui-card flex items-center gap-3 p-4"
        data-motion-key=${"invite:" + offerKey(offer)}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-lg font-medium text-fg">${offer.albumName}</span>
          <span class="mt-0.5 block text-xs text-muted"
            >${busy ? copy("albums.joining", { albumName: offer.albumName }) : copy("albums.invited_you", { owner })}</span
          >
        </span>
        <button
          class="ui-btn-primary shrink-0"
          ?disabled=${joining}
          aria-label=${copy("albums.join", { albumName: offer.albumName })}
          @click=${() => friendOffer.join(offer)}
        >
          ${t("albums.join_2")}
        </button>
      </li>`;
    });
  });
}

const offerKey = (o: OfferSummary) => `${o.code}|${o.owner}`;

/** Row keys in the order albumList renders them, for the motion directive. */
function albumListKeys(view: FoldersViewModel): string[] {
  return [
    ...view.offers.map((o) => "invite:" + offerKey(o)),
    ...view.folders.map((f) => "album:" + f.id),
    ...view.asks.map((a) => "ask:" + a.code),
  ];
}

/** Every row key on Your albums: the page slides its sections when any of them changes. */
function pageKeys(view: FoldersViewModel): string[] {
  return [
    ...view.deleted.map((d) => "notice:" + d.id),
    ...albumListKeys(view),
    ...view.archived.map((f) => "archived:" + f.id),
  ];
}

/** The list shows "Loading…": nothing to animate from yet. */
function listLoading(view: FoldersViewModel): boolean {
  const empty = view.folders.length === 0 && view.asks.length === 0 && view.offers.length === 0;
  return empty && (view.state === "albumsNotLoaded" || view.state === "loadingAlbums");
}

function albumList(view: FoldersViewModel) {
  const empty = view.folders.length === 0 && view.asks.length === 0 && view.offers.length === 0;
  if (listLoading(view)) {
    return html`<p class="text-muted">${t("albums.loading")}</p>`;
  }
  const asks = view.asks;
  const offers = view.offers;
  if (empty) {
    return html`<div class="ui-card p-5 text-center">
      <p class="text-lg text-fg">${t("albums.no_albums_yet")}</p>
      <p class="mt-1 text-sm text-fg">
        ${t("albums.start_one_below_or")}
        <a class="underline" href="/join">${t("albums.join_a_friend_s")}</a>
        ${t("albums.with_their_invite")}
      </p>
    </div>`;
  }
  return html`<ul
    class="space-y-3"
    aria-label=${copy("albums.your_albums")}
    ${gridMotion({ keys: albumListKeys(view), settle: "albums" })}
  >
    ${repeat(offers, offerKey, (o) => offerRow(o))}
    ${repeat(
      view.folders,
      (f) => f.id,
      (f) => albumRow(f),
    )}
    ${repeat(
      asks,
      (a) => a.code,
      (a) => askRow(a),
    )}
  </ul>`;
}

function newAlbumSection(view: FoldersViewModel) {
  const busy = view.state === "creatingAlbum";
  return html`
    <section class="ui-card p-5" data-motion-key="section:new">
      <h2 class="ui-label mb-1">${t("albums.new_album")}</h2>
      <p class="mb-3 text-sm text-fg">${t("albums.start_one_per_trip_family")}</p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const name = input.value.trim();
          if (name) {
            folders.create(name);
            input.value = "";
          }
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder=${copy("albums.album_name")}
          aria-label=${copy("albums.album_name")}
          maxlength="60"
        />
        <wa-button variant="brand" type="submit" ?disabled=${busy || !view.settled}>
          ${busy ? copy("albums.creating") : copy("albums.create_album")}
        </wa-button>
      </form>
    </section>
  `;
}

/** The "doesn't look right" message for a pasted link that could not be read. */
export function joinError() {
  return watch(joinActor, (s) => {
    const { state, error } = joinViewOf(s);
    return state === "showingLinkProblem" && error
      ? html`<p class="mt-2 text-xs text-danger-fg" role="alert">${error}</p>`
      : null;
  });
}

/** True when the pasted text is an invite link: then Continue is the next step, not Create an album. */
export function hasInviteLink(text: string): boolean {
  return parseInviteLink(text).kind === "invite";
}

/** Swaps which button is primary inside `scope`: Continue when an invite is pasted, else Create. */
export function applyPrimaryButtons(scope: ParentNode, invite: boolean) {
  const next = scope.querySelector("[data-join-continue]");
  next?.classList.toggle("ui-btn-primary", invite);
  next?.classList.toggle("ui-btn-ghost", !invite);
  const create = scope.querySelector("[data-create-album]");
  create?.setAttribute("variant", invite ? "neutral" : "brand");
  if (invite) create?.setAttribute("appearance", "filled");
  else create?.removeAttribute("appearance");
}

function joinSection(settled: boolean, busy: boolean, rivalsCreate: boolean) {
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">${t("albums.join_with_an_invite_link")}</h2>
      <p class="mb-3 text-sm text-fg">${t("albums.got_an_invite_link_from")}</p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const text = input.value;
          join.openLink(text);
          if (hasInviteLink(text)) {
            input.value = "";
            input.dispatchEvent(new Event("input"));
          }
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder=${copy("albums.paste_the_invite_link")}
          aria-label=${copy("albums.invite_link")}
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          @input=${(e: Event) => {
            const input = e.currentTarget as HTMLInputElement;
            const scope = input.closest("[data-invite-scope]");
            if (scope) applyPrimaryButtons(scope, hasInviteLink(input.value));
          }}
        />
        <div class="flex gap-2">
          <button
            class="ui-btn-ghost flex-1"
            type="button"
            aria-label=${copy("albums.paste_from_clipboard")}
            @click=${(e: Event) => {
              const form = (e.currentTarget as HTMLButtonElement).closest("form");
              const input = form?.querySelector("input");
              if (input) void pasteKey(input as HTMLInputElement);
            }}
          >
            ${t("albums.paste")}
          </button>
          <button
            class="${rivalsCreate ? "ui-btn-ghost" : "ui-btn-primary"} flex-1"
            data-join-continue
            type="submit"
            ?disabled=${busy || !settled}
          >
            ${t("albums.continue")}
          </button>
        </div>
      </form>
      ${joinError()}
    </section>
  `;
}

/** Sharing → Your albums: every album with its people, plus starting a new one. */
export function albumsPanel() {
  return watch(foldersActor, (s) => {
    const view = foldersViewModel(s);
    return html`<div
      class="space-y-5"
      ${gridMotion({ keys: pageKeys(view), settle: listLoading(view) ? "loading" : "albums-page" })}
    >
      ${errorBanner(
        view.error,
        view.state === "couldNotLoadAlbums" && !view.fatal ? () => folders.retry() : undefined,
        view.fatal ? () => window.location.reload() : undefined,
      )}
      ${deletedNotices(view)}
      <p class="text-sm text-muted" data-motion-key="section:hint">${albumsHint(view.folders)}</p>
      <div data-motion-key="section:albums">${albumList(view)}</div>
      ${archivedSection(view)} ${newAlbumSection(view)}
    </div>`;
  });
}

/** Sharing's hint: only an Admin can invite, so others are told what a tap does for them. */
export function albumsHint(folders: readonly FolderSummary[]): string {
  return folders.length === 0 || folders.some((f) => f.role === "creator")
    ? copy("albums.tap_an_album_to_invite")
    : copy("albums.tap_an_album_to_see");
}

/** Requests still waiting for an answer, shown on the start screen and on Photos. */
export function pendingAsks() {
  return watch(foldersActor, (s) => {
    const waiting = s.context.asks.filter(
      (a) => a.status === "waiting" || (a.status === "linkOff" && !a.closed),
    );
    if (waiting.length === 0) return null;
    return html`<section aria-label=${copy("albums.waiting_to_join")}>
      <h2 class="ui-label mb-2">${t("albums.waiting_to_join")}</h2>
      <ul class="space-y-3">
        ${repeat(
          waiting,
          (a) => a.code,
          (a) => askRow(a),
        )}
      </ul>
    </section>`;
  });
}

/** Sharing → Join: paste an invite to ask into someone's album. */
/** `rivalsCreate`: a Create an album button sits beside it, so Continue is primary only once a link is pasted. */
export function joinPanel(rivalsCreate = false) {
  return watch(syncActor, (s) => {
    const syncVm = syncViewModel(s);
    return joinSection(syncVm.settled, syncVm.busy, rivalsCreate);
  });
}
