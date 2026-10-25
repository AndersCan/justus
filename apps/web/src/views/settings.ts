import { html } from "lit-html";
import { atom } from "nanostores";
import type { FolderSummary } from "@justus/core";
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
import { logsPanel } from "./logs";

/** Group a 64-char hex key as "8 groups of 8" — readable, copyable. */
function groupKey(key: string): string {
  return key.replace(/(.{8})/g, "$1 ").trim();
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

async function pasteKey(input: HTMLInputElement) {
  try {
    const text = await navigator.clipboard.readText();
    const key = text.trim().replace(/\s+/g, "");
    input.value = key;
    $pasteError.set(key.length > 0 && !/^[0-9a-f]{64}$/i.test(key));
  } catch {
    $pasteError.set(true);
  }
}

const $copiedKey = atom<string | null>(null);
const $pasteError = atom(false);
const $joinProgress = atom(false);

// Navigate to the gallery once a join lands (joining → ok) — the folder's
// photos then appear without the user hunting for them. When the join turns
// out to be a *request* (the folder is pending creator approval), stay put
// and explain instead of navigating.
let seenJoin: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenJoin === "joining" && state === "ok") {
    const pending = $syncStatus.get()?.folder?.pending;
    if (pending) {
      toast("Request sent — the creator will approve it from their Requests tab");
      $router.open("/requests", true);
    } else {
      toast("You're in — photos are syncing");
      $router.open("/", true);
    }
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

async function shareFolder(folder: FolderSummary) {
  const text = `Join my Justus folder “${folder.name}”: ${folder.shareKey}`;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: `Justus folder “${folder.name}”`, text });
      return;
    } catch {
      // share dismissed/failed — fall through to copy
    }
  }
  const ok = await copyText(folder.shareKey);
  $copiedKey.set(ok ? folder.shareKey : null);
  setTimeout(() => $copiedKey.set(null), 2000);
  toast(ok ? "Share key copied" : "Couldn't copy — the key is shown above");
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
                        <span class="truncate text-base font-semibold text-fg">${f.name}</span>
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
                        @click=${() => void shareFolder(f)}
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

function inviteSection(status: NonNullable<SyncViewModel["status"]>) {
  const f = status.folder;
  const intro =
    f.role === "creator"
      ? "Share the key, then approve the device in the Requests tab to let it add photos. Anyone with the key can also request to join."
      : "Share this key so other devices can request to join this folder too.";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Share “${f.name}”</h2>
      <p class="mb-4 text-sm text-fg">${intro}</p>
      <div
        class="rounded-2xl bg-subtle px-4 py-3 text-[11px] leading-relaxed font-mono tracking-widest text-fg"
      >
        ${groupKey(f.shareKey)}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        ${useStore(
          $copiedKey,
          (copied) => html`<button class="ui-btn-primary" @click=${() => void shareFolder(f)}>
            ${copied === f.shareKey ? "Copied ✓" : "Copy share key"}
          </button>`,
        )}
        ${
          typeof navigator.share === "function"
            ? html`<button class="ui-btn-ghost" @click=${() => void shareFolder(f)}>Share…</button>`
            : null
        }
      </div>
    </section>
  `;
}

function enrollSection(status: NonNullable<SyncViewModel["status"]>, state: string, busy: boolean) {
  if (status.folder.role !== "creator") {
    return html`<section class="ui-card p-5">
      <h2 class="ui-label mb-1">Approve a writer</h2>
      <p class="text-sm text-fg">
        Only the folder's creator can approve writers — head to Requests.
      </p>
    </section>`;
  }
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Approve a writer</h2>
      <p class="mb-3 text-sm text-fg">
        Paste a device's drive key to add it as a writer directly, or approve pending requests in
        the Requests tab.
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
      <h2 class="ui-label mb-1">Join a folder</h2>
      <p class="mb-3 text-sm text-fg">
        Paste a share key to request to join someone's folder. The creator approves your request
        before you can add photos.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const key = input.value.trim().replace(/\s+/g, "");
          if (!/^[0-9a-f]{64}$/i.test(key)) {
            $pasteError.set(true);
            return;
          }
          $pasteError.set(false);
          sync.join(key);
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder="64-char hex share key"
          aria-label="Share key"
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          @input=${() => $pasteError.set(false)}
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
      ${useStore($pasteError, (err) =>
        err
          ? html`<p class="mt-2 text-xs text-danger">
              That key doesn't look right — check you copied it whole (64 hex chars).
            </p>`
          : null,
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
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Folder</h1>

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
      ${status ? html`${inviteSection(status)} ${enrollSection(status, state, busy)}` : null}
      ${joinSection(state, busy)} ${status ? deviceSection(status) : null} ${advancedLogsSection()}
    </div>
  `;
}

export function settingsView() {
  return useStore($foldersViewModel, (foldersVm) =>
    useStore($syncViewModel, (syncVm) => bindingsBody(foldersVm, syncVm)),
  );
}
