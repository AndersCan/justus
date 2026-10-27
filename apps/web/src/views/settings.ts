import { html } from "lit-html";
import { $foldersViewModel, folders } from "../machines/folders-machine";
import { $syncViewModel, sync } from "../machines/sync-machine";
import { useStore } from "../use-store";
import { errorBanner } from "./error-banner";
import { invitePanel } from "./invite";
import { logsPanel } from "./logs";

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

function deviceSection(status: NonNullable<SyncViewModel["status"]>) {
  return html`
    <section class="ui-card p-5">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="ui-label">Active album</h2>
        ${rolePill(status.folder.role)}
      </div>
      <dl class="grid grid-cols-2 gap-y-2 text-sm">
        <dt class="text-muted">Album</dt>
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
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Settings</h1>

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
      ${nameSection(foldersVm)}
      <a class="ui-card flex items-center justify-between gap-3 p-4 text-sm" href="/albums">
        <span>
          <span class="block font-medium text-fg">Your albums</span>
          <span class="text-muted">Create an album, join one, or switch between them.</span>
        </span>
        <span class="text-muted" aria-hidden="true">→</span>
      </a>
      ${status ? html`${invitePanel(status.folder, status.name)} ${enrollSection(status, state, busy)}` : null}
      ${status ? deviceSection(status) : null} ${advancedLogsSection()}
    </div>
  `;
}

export function settingsView() {
  return useStore($foldersViewModel, (foldersVm) =>
    useStore($syncViewModel, (syncVm) => bindingsBody(foldersVm, syncVm)),
  );
}
