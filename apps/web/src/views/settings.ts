import { html } from "lit-html";
import { atom } from "nanostores";
import { $foldersViewModel, folders } from "../machines/folders-machine";
import {
  $syncState,
  $syncStatus,
  $syncViewModel,
  sync,
  type SyncStateName,
} from "../machines/sync-machine";
import { $router } from "../router";
import { useStore } from "../use-store";
import { errorBanner } from "./error-banner";
import { toast } from "./toast";
import { groupKey, invitePanel, shareInvite } from "./invite";
import { invites, $inviteError } from "../machines/invite-machine";
import { logsPanel } from "./logs";

async function pasteKey(input: HTMLInputElement) {
  try {
    input.value = (await navigator.clipboard.readText()).trim();
    invites.clearError();
  } catch {
    toast("Couldn't read the clipboard. Paste the invite into the box.");
  }
}

const $joinProgress = atom(false);

// Navigate to the gallery once a join lands (joining → ok) — the folder's
// photos then appear without the user hunting for them. When the join turns
// out to be a *request* (the folder is pending Admin approval), the gallery
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

type SyncViewModel = ReturnType<typeof $syncViewModel.get>;
type FoldersViewModel = ReturnType<typeof $foldersViewModel.get>;

function rolePill(role: string) {
  const dot = role === "creator" ? "bg-accent" : role === "member" ? "bg-ok" : "bg-warn";
  return html`<span
    class="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-xs font-semibold text-fg"
  >
    <span class="h-2 w-2 rounded-full ${dot}"></span>
    ${role}
  </span>`;
}

function nameSection(view: FoldersViewModel) {
  const saving = view.state === "renaming";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Your name</h2>
      <p class="mb-3 text-sm text-fg">
        Shown to others as the member behind the photos you add and the join requests you send.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const name = input.value.trim();
          if (name && name !== view.userName) folders.rename(name);
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder="Your name"
          aria-label="Your name"
          value="${view.userName}"
          spellcheck="false"
          autocomplete="name"
        />
        <button class="ui-btn-primary" type="submit" ?disabled=${saving}>
          ${saving ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  `;
}

function newFolderSection(view: FoldersViewModel) {
  const busy = view.state === "creating";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">New folder</h2>
      <p class="mb-3 text-sm text-fg">
        Create a fresh folder to share on its own — each folder has its own members and share key.
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
          placeholder="Folder name"
          aria-label="Folder name"
          maxlength="60"
        />
        <button class="ui-btn-primary" type="submit" ?disabled=${busy || view.state !== "ok"}>
          ${busy ? "Creating…" : "Create folder"}
        </button>
      </form>
    </section>
  `;
}

function folderListSection(view: FoldersViewModel) {
  const activeId = view.activeFolderId;
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-3">Your folders</h2>
      ${
        view.folders.length === 0
          ? html`<p class="text-sm text-fg">No folders yet — create one above.</p>`
          : html`<ul class="space-y-3">
              ${view.folders.map(
                (f) => html`
                  <li
                    class="flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
                      f.id === activeId
                        ? "border-accent/40 bg-subtle/50"
                        : "border-line bg-white/60"
                    }"
                  >
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="truncate  text-lg text-fg">${f.name}</span>
                        ${rolePill(f.role)}
                        ${
                          f.pending
                            ? html`<span class="text-xs font-semibold text-warn"
                                >Pending approval</span
                              >`
                            : null
                        }
                        ${
                          f.id === activeId
                            ? html`<span class="text-xs font-semibold text-accent"
                                >Now showing</span
                              >`
                            : null
                        }
                      </div>
                      <p class="mt-1 text-xs text-muted">
                        ${f.members} member${f.members === 1 ? "" : "s"} · added
                        ${new Date(f.addedAt).toLocaleDateString()}
                      </p>
                      <div class="mt-2 break-all font-mono text-[10px] leading-relaxed text-muted">
                        ${groupKey(f.shareKey)}
                      </div>
                    </div>
                    <div class="flex shrink-0 flex-wrap gap-2">
                      <button
                        class="ui-btn-ghost"
                        aria-label="Share ${f.name}"
                        @click=${() => void shareInvite(f, view.userName)}
                      >
                        Share
                      </button>
                      ${
                        f.id !== activeId
                          ? html`<button
                              class="ui-btn-ghost"
                              ?disabled=${view.state === "switching"}
                              @click=${() => folders.switchTo(f.id)}
                            >
                              Show
                            </button>`
                          : null
                      }
                    </div>
                  </li>
                `,
              )}
            </ul>`
      }
    </section>
  `;
}

function enrollSection(status: NonNullable<SyncViewModel["status"]>, state: string, busy: boolean) {
  if (status.folder.role !== "creator") {
    return html`<section class="ui-card p-5">
      <h2 class="ui-label mb-1">Approve a writer</h2>
      <p class="text-sm text-fg">Only the Admin can approve people. Open People from the header.</p>
    </section>`;
  }
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Approve a writer</h2>
      <p class="mb-3 text-sm text-fg">
        Paste a device's drive key to add it as a writer directly, or approve pending requests from
        People in the header.
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
        <button class="ui-btn-ghost" type="submit" ?disabled=${busy || state !== "ok"}>
          Enroll
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
              Connecting to the folder…
            </p>`
          : null,
      )}
      <p class="mt-3 text-xs text-muted">
        Joining adds the folder to this device — you can switch between your folders on this page.
      </p>
    </section>
  `;
}

function deviceSection(status: NonNullable<SyncViewModel["status"]>) {
  return html`
    <section class="ui-card p-5">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="ui-label">Active folder</h2>
        ${rolePill(status.folder.role)}
      </div>
      <dl class="grid grid-cols-2 gap-y-2 text-sm">
        <dt class="text-muted">Folder</dt>
        <dd>${status.folder.name}</dd>
        <dt class="text-muted">Your name</dt>
        <dd>${status.name}</dd>
        <dt class="text-muted">Peers</dt>
        <dd>${status.peers}</dd>
        <dt class="text-muted">Photos</dt>
        <dd>${status.photos}</dd>
        <dt class="text-muted">Members</dt>
        <dd>${status.members.length}</dd>
      </dl>
      <details class="mt-3 text-xs text-muted">
        <summary class="cursor-pointer select-none">Advanced</summary>
        <dl class="mt-2 space-y-1 break-all font-mono">
          <dt>Drive key</dt>
          <dd>${status.folder.driveKey || status.driveKey}</dd>
          <dt>Discovery key</dt>
          <dd>${status.discoveryKey}</dd>
          <dt>Share key</dt>
          <dd>${status.folder.shareKey}</dd>
        </dl>
      </details>
    </section>
  `;
}

function advancedLogsSection() {
  return html`<details class="text-xs text-muted">
    <summary class="ui-label cursor-pointer select-none">Advanced</summary>
    <div class="mt-3">${logsPanel()}</div>
  </details>`;
}

function bindingsBody(foldersVm: FoldersViewModel, syncVm: SyncViewModel) {
  const { state, busy, error, fatal } = syncVm;
  const status = syncVm.status;
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Folders &amp; devices</h1>

      ${errorBanner(
        error || foldersVm.error,
        (state === "error" || foldersVm.state === "error") && !fatal && !foldersVm.fatal
          ? () => {
              sync.retry();
              folders.retry();
            }
          : undefined,
        fatal || foldersVm.fatal ? () => window.location.reload() : undefined,
      )}
      ${nameSection(foldersVm)} ${newFolderSection(foldersVm)} ${folderListSection(foldersVm)}
      ${status ? html`${invitePanel(status.folder, status.name)} ${enrollSection(status, state, busy)}` : null}
      ${joinSection(state, busy)} ${status ? deviceSection(status) : null} ${advancedLogsSection()}
    </div>
  `;
}

export function settingsView() {
  return useStore($foldersViewModel, (foldersVm) =>
    useStore($syncViewModel, (syncVm) => bindingsBody(foldersVm, syncVm)),
  );
}
