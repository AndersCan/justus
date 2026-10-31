import { html } from "lit-html";
import { atom } from "nanostores";
import type { FolderSummary } from "@justus/core";
import {
  $activeFolderId,
  $folders,
  $foldersError,
  $foldersState,
  $foldersViewModel,
  folders,
} from "../machines/folders-machine";
import {
  $syncState,
  $syncStatus,
  $syncViewModel,
  type SyncStateName,
} from "../machines/sync-machine";
import { invites, $inviteError } from "../machines/invite-machine";
import { $requests, requests } from "../machines/requests-machine";
import { people } from "../machines/people-machine";
import { $router } from "../router";
import { useStore } from "../use-store";
import { friendlyError } from "../utils/friendly-error";
import { errorBanner } from "./error-banner";
import { toast } from "./toast";

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
    invites.clearError();
  } catch {
    toast("Couldn't read the clipboard. Paste the invite link into the box.");
  }
}

const $joinProgress = atom(false);

// Refresh the request inbox when the album state turns over (a join or an
// approval can change pending requests). Push-driven refreshes are handled in
// handle-message.
let seenSync: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenSync && state !== seenSync) requests.refresh();
  seenSync = state;
});

// Open the album in Photos once a join lands (joining → ok) — its photos then
// appear without the user hunting for them. When the join turns out to be a
// *request* (pending Admin approval), the album page explains that it waits.
let seenJoin: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenJoin === "joining" && state === "ok") {
    const folder = $syncStatus.get()?.folder;
    toast(
      folder?.pending
        ? "You're in. You can add photos once the Admin approves you"
        : "You're in. Photos are on their way",
    );
    $router.open(folder ? `/albums/${folder.id}` : "/", true);
  }
  seenJoin = state;
  $joinProgress.set(state === "joining");
});

// A new album opens in Photos (ready for its first photos) once the create
// lands; a failed create stays here with its error.
let prevFoldersState = $foldersState.get();
$foldersState.listen((state) => {
  if (
    prevFoldersState === "creating" &&
    state === "ok" &&
    !$foldersError.get() &&
    $router.get()?.route === "sharing"
  ) {
    const id = $activeFolderId.get();
    $router.open(id ? `/albums/${id}` : "/albums");
  }
  prevFoldersState = state;
});

/** Pages about one album (its photos, its people) make it the active album,
 * so presence, invite and requests describe the album on screen. */
function followRouteAlbum() {
  const page = $router.get();
  const id = page?.route === "photoAlbum" || page?.route === "album" ? page.params.id : null;
  if (!id || id === $activeFolderId.get() || $foldersState.get() !== "ok") return;
  if ($folders.get().some((f) => f.id === id)) folders.switchTo(id);
}
$foldersState.listen(followRouteAlbum);

// The album page is the people sheet's home: open/close its machine with the
// route, and keep the join-request inbox fresh on the sharing pages.
$router.listen((page, old) => {
  if (page?.route === "album") people.open();
  else if (old?.route === "album") people.close();
  if (page?.route === "album" || page?.route === "sharing") requests.refresh();
  followRouteAlbum();
});

type FoldersViewModel = ReturnType<typeof $foldersViewModel.get>;
type SyncViewModel = ReturnType<typeof $syncViewModel.get>;

/** "Admin · 3 members", one text node so it reads (and matches) as one line. */
function roleAndCount(folder: FolderSummary): string {
  const count = `${folder.members} member${folder.members === 1 ? "" : "s"}`;
  return `${roleLabel(folder.role, folder.pending)} · ${count}`;
}

function albumRow(folder: FolderSummary) {
  return html`
    <li class="flex items-center gap-3 rounded-2xl border border-line p-4">
      <a
        class="ui-focus min-w-0 flex-1"
        href="/sharing/${folder.id}"
        aria-label="Invite & members of ${folder.name}"
      >
        <span class="block truncate text-lg font-medium text-fg">${folder.name}</span>
        <span
          class="mt-0.5 block text-xs ${folder.pending ? "font-semibold text-warn" : "text-muted"}"
          >${roleAndCount(folder)}</span
        >
      </a>
      ${useStore($requests, (reqs) => {
        const waiting =
          folder.role === "creator" ? reqs.filter((r) => r.folderId === folder.id).length : 0;
        return waiting > 0
          ? html`<span
              class="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white"
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

function albumList(view: FoldersViewModel) {
  if (view.state === "idle" || (view.state === "refreshing" && view.folders.length === 0)) {
    return html`<p class="text-muted">Loading…</p>`;
  }
  if (view.folders.length === 0) {
    return html`<div class="ui-card p-5 text-center">
      <p class="text-lg text-fg">No albums yet.</p>
      <p class="mt-1 text-sm text-fg">
        Start one below, or <a class="underline" href="/join">join a friend's</a> with their invite.
      </p>
    </div>`;
  }
  return html`<ul class="space-y-3" aria-label="Your albums">
    ${view.folders.map((f) => albumRow(f))}
  </ul>`;
}

function newAlbumSection(view: FoldersViewModel) {
  const busy = view.state === "creating";
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
        <button class="ui-btn-primary" type="submit" ?disabled=${busy || view.state !== "ok"}>
          ${busy ? "Creating…" : "Create album"}
        </button>
      </form>
    </section>
  `;
}

function joinSection(state: string, busy: boolean) {
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Join with an invite link</h2>
      <p class="mb-3 text-sm text-fg">
        Got an invite link from someone? Paste it here to see their album.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          invites.receive(input.value);
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
          @input=${() => invites.clearError()}
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
          ${useStore(
            $joinProgress,
            (joining) => html`<button
              class="ui-btn-primary flex-1"
              type="submit"
              ?disabled=${busy || state !== "ok" || joining}
            >
              ${joining ? "Joining…" : "Join"}
            </button>`,
          )}
        </div>
      </form>
      ${useStore($inviteError, (err) =>
        err
          ? html`<p class="mt-2 text-xs text-danger" role="alert">${friendlyError(err)}</p>`
          : null,
      )}
      ${useStore($joinProgress, (joining) =>
        joining
          ? html`<p class="mt-3 flex items-center gap-2 text-sm text-fg">
              <span
                class="h-2 w-2 animate-pulse rounded-full bg-warn motion-reduce:animate-none"
              ></span>
              Finding the album… This works best while the person who invited you has Justus open.
            </p>`
          : null,
      )}
    </section>
  `;
}

/** Sharing → Your albums: every album with its people, plus starting a new one. */
export function albumsPanel() {
  return useStore(
    $foldersViewModel,
    (view) => html`
      ${errorBanner(
        view.error,
        view.state === "error" && !view.fatal ? () => folders.retry() : undefined,
        view.fatal ? () => window.location.reload() : undefined,
      )}
      <p class="text-sm text-muted">
        Each album has its own people and its own invite link. Open one to invite someone or to let
        people add photos.
      </p>
      ${albumList(view)} ${newAlbumSection(view)}
    `,
  );
}

/** Sharing → Join: paste an invite to ask into someone's album. */
export function joinPanel() {
  return useStore($syncViewModel, (syncVm: SyncViewModel) =>
    joinSection(syncVm.state, syncVm.busy),
  );
}
