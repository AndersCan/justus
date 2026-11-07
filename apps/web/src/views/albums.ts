import { html } from "lit-html";
import type { AskSummary, FolderSummary, OfferSummary } from "@justus/core";
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
import { currentPage, onPageChange, open } from "../machines/router-machine";
import { onStateChange } from "../machines/actor-utils";
import { parseInviteLink } from "../utils/invite-link";
import { errorBanner } from "./error-banner";
import { gridMotion } from "./grid-motion";
import { toast } from "./toast";

// A friend's invite opens the album once the Admin's phone lets this phone in;
// if it never does, the row goes back to Join and says why.
onOutput(friendOfferActor, (e) => {
  if (e.type === "openAlbum") open(`/albums/${(e.payload as { folderId: string }).folderId}`);
  if (e.type === "couldNotJoin") {
    const { albumName, ownerName } = e.payload as { albumName: string; ownerName: string };
    toast(`Couldn't join “${albumName}”. ${ownerName} needs Justus open too.`);
  }
});

/** User-facing role words (CONTEXT.md "User-facing words"). A pending join is
 * a Reader in code, but to the user it is a request still waiting. */
export function roleLabel(role: FolderSummary["role"], pending = false): string {
  if (pending) return "Waiting for approval";
  if (role === "creator") return "Admin";
  if (role === "member") return "Member";
  return "Viewer";
}

async function pasteKey(input: HTMLInputElement) {
  try {
    input.value = (await navigator.clipboard.readText()).trim();
  } catch {
    toast("Couldn't read the clipboard. Paste the invite link into the box.");
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

// A new album opens in Photos (ready for its first photos) once the create
// lands; a failed create stays here with its error.
onStateChange(foldersActor, FOLDERS_STATES, (next, prev) => {
  const { error, activeId } = foldersActor.snapshot().context;
  if (
    prev === "creatingAlbum" &&
    next === "showingAlbums" &&
    !error &&
    currentPage()?.route === "sharing"
  ) {
    open(activeId ? `/albums/${activeId}` : "/albums");
  }
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
// route, and keep the join-request inbox fresh on the sharing pages.
onPageChange((page, old) => {
  if (page?.route === "album" && old?.route === "album" && page.params.id !== old.params.id) {
    people.close();
  }
  if (page?.route === "album") people.open();
  else if (old?.route === "album") people.close();
  if (page?.route === "album" || page?.route === "sharing") requests.refresh();
  followRouteAlbum();
});

type FoldersViewModel = ReturnType<typeof foldersViewModel>;

/** "Admin · 3 members", one text node so it reads (and matches) as one line. */
function roleAndCount(folder: FolderSummary): string {
  const count = `${folder.members} member${folder.members === 1 ? "" : "s"}`;
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
        aria-label="Invite & members of ${folder.name}"
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
              aria-label="${waiting} waiting for approval"
              >${waiting}</span
            >`
          : null;
      })}
      <a
        class="ui-btn-ghost inline-flex shrink-0 items-center"
        href="/albums/${folder.id}"
        aria-label="Photos in ${folder.name}"
        >Photos</a
      >
      <span class="text-muted" aria-hidden="true">›</span>
    </li>
  `;
}

function askRow(ask: AskSummary) {
  const declined = ask.status === "declined";
  return html`
    <li data-motion-key=${"ask:" + ask.code}>
      <button
        class="ui-focus flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left"
        aria-label="${declined ? "Not accepted" : "Waiting for " + ask.ownerName + " to accept"}: ${ask.albumName}"
        @click=${() => join.reopenRequest(ask)}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-lg font-medium text-fg">${ask.albumName}</span>
          <span
            class="mt-0.5 block text-xs ${declined ? "text-muted" : "font-semibold text-warn-fg"}"
            >${declined ? "Not accepted" : `Waiting for ${ask.ownerName} to accept`}</span
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
            >${busy ? `Joining “${offer.albumName}”...` : `${owner} invited you`}</span
          >
        </span>
        <button
          class="ui-btn-primary shrink-0"
          ?disabled=${joining}
          aria-label="Join ${offer.albumName}"
          @click=${() => friendOffer.join(offer)}
        >
          Join
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

function albumList(view: FoldersViewModel) {
  const empty = view.folders.length === 0 && view.asks.length === 0 && view.offers.length === 0;
  if (empty && (view.state === "albumsNotLoaded" || view.state === "loadingAlbums")) {
    return html`<p class="text-muted">Loading…</p>`;
  }
  const asks = view.asks;
  const offers = view.offers;
  if (empty) {
    return html`<div class="ui-card p-5 text-center">
      <p class="text-lg text-fg">No albums yet.</p>
      <p class="mt-1 text-sm text-fg">
        Start one below, or <a class="underline" href="/join">join a friend's</a> with their invite.
      </p>
    </div>`;
  }
  return html`<ul
    class="space-y-3"
    aria-label="Your albums"
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
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">New album</h2>
      <p class="mb-3 text-sm text-fg">Start one per trip, family or group.</p>
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
          placeholder="Album name"
          aria-label="Album name"
          maxlength="60"
        />
        <wa-button variant="brand" type="submit" ?disabled=${busy || !view.settled}>
          ${busy ? "Creating…" : "Create album"}
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

function joinSection(settled: boolean, busy: boolean) {
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Join with an invite link</h2>
      <p class="mb-3 text-sm text-fg">
        Got an invite link from someone? Paste it here to ask to join their album.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const text = input.value;
          join.openLink(text);
          if (parseInviteLink(text).kind === "invite") input.value = "";
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder="Paste the invite link"
          aria-label="Invite link"
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
        />
        <div class="flex gap-2">
          <button
            class="ui-btn-ghost flex-1"
            type="button"
            aria-label="Paste from clipboard"
            @click=${(e: Event) => {
              const form = (e.currentTarget as HTMLButtonElement).closest("form");
              const input = form?.querySelector("input");
              if (input) void pasteKey(input as HTMLInputElement);
            }}
          >
            Paste
          </button>
          <button class="ui-btn-primary flex-1" type="submit" ?disabled=${busy || !settled}>
            Continue
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
    return html`
      ${errorBanner(
        view.error,
        view.state === "couldNotLoadAlbums" && !view.fatal ? () => folders.retry() : undefined,
        view.fatal ? () => window.location.reload() : undefined,
      )}
      <p class="text-sm text-muted">
        Tap an album to invite people or see who's in it. Each album has its own invite link.
      </p>
      ${albumList(view)} ${newAlbumSection(view)}
    `;
  });
}

/** Requests still waiting for an answer, shown on the start screen and on Photos. */
export function pendingAsks() {
  return watch(foldersActor, (s) => {
    const waiting = s.context.asks.filter((a) => a.status === "waiting");
    if (waiting.length === 0) return null;
    return html`<section aria-label="Waiting to join">
      <h2 class="ui-label mb-2">Waiting to join</h2>
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
export function joinPanel() {
  return watch(syncActor, (s) => {
    const syncVm = syncViewModel(s);
    return joinSection(syncVm.settled, syncVm.busy);
  });
}
