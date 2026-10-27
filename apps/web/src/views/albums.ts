import { html } from "lit-html";
import { atom } from "nanostores";
import type { FolderSummary } from "@justus/core";
import {
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
import { $router } from "../router";
import { useStore } from "../use-store";
import { errorBanner } from "./error-banner";
import { shareInvite } from "./invite";
import { toast } from "./toast";

/** User-facing role words (CONTEXT.md "User-facing words"). */
export function roleLabel(role: FolderSummary["role"]): string {
  if (role === "creator") return "Admin";
  if (role === "member") return "Member";
  return "Viewer";
}

async function pasteKey(input: HTMLInputElement) {
  try {
    input.value = (await navigator.clipboard.readText()).trim();
    invites.clearError();
  } catch {
    toast("Couldn't read the clipboard. Paste the invite into the box.");
  }
}

const $joinProgress = atom(false);

// Navigate to the gallery once a join lands (joining → ok) — the album's
// photos then appear without the user hunting for them. When the join turns
// out to be a *request* (the album is pending Admin approval), the gallery
// explains that it is waiting.
let seenJoin: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenJoin === "joining" && state === "ok") {
    const pending = $syncStatus.get()?.folder?.pending;
    toast(pending ? "Request sent. Waiting for the Admin." : "You're in. Photos are syncing");
    $router.open("/", true);
  }
  seenJoin = state;
  $joinProgress.set(state === "joining");
});

// A new album opens in the Photos tab once the create lands; a failed create
// stays here with its error.
let prevFoldersState = $foldersState.get();
$foldersState.listen((state) => {
  if (
    prevFoldersState === "creating" &&
    state === "ok" &&
    !$foldersError.get() &&
    $router.get()?.route === "albums"
  ) {
    $router.open("/");
  }
  prevFoldersState = state;
});

type FoldersViewModel = ReturnType<typeof $foldersViewModel.get>;
type SyncViewModel = ReturnType<typeof $syncViewModel.get>;

/** Open an album in the Photos tab. */
function openAlbum(view: FoldersViewModel, folder: FolderSummary) {
  if (folder.id !== view.activeFolderId) folders.switchTo(folder.id);
  $router.open("/");
}

function albumRow(view: FoldersViewModel, folder: FolderSummary) {
  const active = folder.id === view.activeFolderId;
  return html`
    <li
      class="flex items-center gap-3 rounded-2xl border p-4 ${
        active ? "border-accent/40 bg-subtle/50" : "border-line"
      }"
    >
      <button
        class="ui-focus min-w-0 flex-1 text-left"
        ?disabled=${view.state === "switching"}
        aria-label="Open ${folder.name}"
        @click=${() => openAlbum(view, folder)}
      >
        <span class="flex items-center gap-2">
          <span class="truncate text-lg font-medium text-fg">${folder.name}</span>
          ${
            active
              ? html`<span class="shrink-0 text-xs font-semibold text-accent">Showing</span>`
              : null
          }
        </span>
        <span class="mt-0.5 block text-xs text-muted">
          ${roleLabel(folder.role)} · ${folder.members} member${folder.members === 1 ? "" : "s"}
          ${
            folder.pending
              ? html` · <span class="font-semibold text-warn">Waiting for the Admin</span>`
              : null
          }
        </span>
      </button>
      <button
        class="ui-btn-ghost shrink-0"
        aria-label="Invite people to ${folder.name}"
        @click=${() => void shareInvite(folder, view.userName)}
      >
        Invite
      </button>
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
      <p class="mt-1 text-sm text-fg">Create one below, or join a friend's with their invite.</p>
    </div>`;
  }
  return html`<ul class="space-y-3" aria-label="Your albums">
    ${view.folders.map((f) => albumRow(view, f))}
  </ul>`;
}

function newAlbumSection(view: FoldersViewModel) {
  const busy = view.state === "creating";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">New album</h2>
      <p class="mb-3 text-sm text-fg">
        Each album has its own people and its own invite. Start one per trip, family or group.
      </p>
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
      <h2 class="ui-label mb-1">Join with an invite</h2>
      <p class="mb-3 text-sm text-fg">
        Paste an invite link or key to ask to join someone's album. The Admin approves your request.
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
          placeholder="Paste an invite link or key"
          aria-label="Invite link or key"
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
        err ? html`<p class="mt-2 text-xs text-danger" role="alert">${err}</p>` : null,
      )}
      ${useStore($joinProgress, (joining) =>
        joining
          ? html`<p class="mt-3 flex items-center gap-2 text-sm text-fg">
              <span
                class="h-2 w-2 animate-pulse rounded-full bg-warn motion-reduce:animate-none"
              ></span>
              Connecting to the album…
            </p>`
          : null,
      )}
    </section>
  `;
}

function albumsBody(view: FoldersViewModel, syncVm: SyncViewModel) {
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Albums</h1>
      ${errorBanner(
        view.error,
        view.state === "error" && !view.fatal ? () => folders.retry() : undefined,
        view.fatal ? () => window.location.reload() : undefined,
      )}
      ${albumList(view)} ${newAlbumSection(view)} ${joinSection(syncVm.state, syncVm.busy)}
    </div>
  `;
}

export function albumsView() {
  return useStore($foldersViewModel, (view) =>
    useStore($syncViewModel, (syncVm) => albumsBody(view, syncVm)),
  );
}
