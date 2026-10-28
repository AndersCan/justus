import { html } from "lit-html";
import { atom } from "nanostores";
import { folders } from "../machines/folders-machine";
import { $peopleViewModel, people } from "../machines/people-machine";
import { requests } from "../machines/requests-machine";
import { $syncViewModel, sync } from "../machines/sync-machine";
import { $router } from "../router";
import { useStore } from "../use-store";
import { avatarBadge } from "./avatar";
import { roleLabel } from "./albums";
import { confirmAction } from "./confirm";
import { errorBanner } from "./error-banner";
import { invitePanel } from "./invite";
import { toast } from "./toast";

type PeopleVm = ReturnType<typeof $peopleViewModel.get>;
type Status = NonNullable<ReturnType<typeof $syncViewModel.get>["status"]>;

/** The invite (link + QR) is only drawn after a deliberate confirmation, and
 * is hidden again whenever the page is left. */
const $inviteShownFor = atom<string | null>(null);
$router.listen((page) => {
  if (page?.route !== "album") $inviteShownFor.set(null);
});

function memberRow(vm: PeopleVm, p: PeopleVm["people"][number]) {
  return html`<li class="flex items-center gap-3 py-2">
    ${avatarBadge(p.name)}
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-fg">
        ${p.name}${p.you ? " (you)" : ""}
        ${p.admin ? html`<span class="ml-1 text-xs font-normal text-muted">· Admin</span>` : null}
      </p>
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full ${p.connected ? "bg-ok" : "bg-line"}"
          aria-hidden="true"
        ></span>
        ${p.presence}
      </p>
    </div>
    ${
      vm.isAdmin && !p.you && !p.admin
        ? html`<button
            class="text-xs text-muted underline-offset-2 hover:text-danger hover:underline"
            ?disabled=${vm.removing}
            @click=${async () => {
              const ok = await confirmAction({
                title: `Remove ${p.name}?`,
                detail:
                  "They stop syncing with this album. Photos already on their devices stay there.",
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

function requestRow(r: PeopleVm["requests"][number]) {
  return html`<li class="rounded-xl bg-subtle p-3">
    <p class="text-sm text-fg">
      <span class="font-semibold">${r.requesterName}</span> wants to join
    </p>
    <p class="mt-1 text-xs text-muted">
      Approving means they can see everything in this album, past and future, and can see when
      you’re connected.
    </p>
    <div class="mt-2 flex gap-2">
      <button
        class="ui-btn-ghost"
        @click=${() => requests.respond(r.folderId, r.requesterKey, false)}
      >
        Decline
      </button>
      <button
        class="ui-btn-primary"
        @click=${() => {
          requests.respond(r.folderId, r.requesterKey, true);
          toast(`${r.requesterName} is in`);
        }}
      >
        Approve
      </button>
    </div>
  </li>`;
}

function requestsSection(vm: PeopleVm) {
  if (vm.requests.length === 0) return null;
  return html`<section class="ui-card border-l-4 border-l-warn p-5">
    <h2 class="ui-label mb-3">Waiting for your approval</h2>
    <ul class="space-y-2">
      ${vm.requests.map((r) => requestRow(r))}
    </ul>
  </section>`;
}

function membersSection(vm: PeopleVm) {
  return html`<section class="ui-card p-5">
    <h2 class="ui-label">Members</h2>
    <p class="mb-2 mt-1 text-xs text-muted">
      Connected means your device can reach them right now. Everyone in the album can see this.
    </p>
    ${vm.error ? html`<p class="mb-2 text-xs text-danger" role="alert">${vm.error}</p>` : null}
    <ul class="divide-y divide-line">
      ${vm.people.map((p) => memberRow(vm, p))}
    </ul>
  </section>`;
}

function inviteSection(status: Status) {
  const folder = status.folder;
  return html`<section class="ui-card p-5">
    <h2 class="ui-label mb-1">Invite people</h2>
    ${useStore($inviteShownFor, (shown) =>
      shown === folder.id
        ? html`<div class="-mx-5 -mb-5 mt-3">${invitePanel(folder, status.name)}</div>`
        : html`<p class="mb-3 text-sm text-fg">
              Show the invite link and QR code for “${folder.name}”.
            </p>
            <button
              class="ui-btn-ghost"
              @click=${async () => {
                const ok = await confirmAction({
                  title: `Invite people to “${folder.name}”?`,
                  detail:
                    "Anyone who gets the link or QR code can ask to join, and the Admin must approve each person. Share it only with people you trust, and not in public places.",
                  confirmLabel: "Show invite",
                  tone: "accent",
                });
                if (ok) $inviteShownFor.set(folder.id);
              }}
            >
              Show invite…
            </button>`,
    )}
  </section>`;
}

function enrollSection(status: Status, state: string, busy: boolean) {
  if (status.folder.role !== "creator") return null;
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Approve a writer</h2>
      <p class="mb-3 text-sm text-fg">
        Paste a device's drive key to add it as a writer directly, or approve pending requests
        above.
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

function detailsSection(status: Status) {
  return html`<details class="text-xs text-muted">
    <summary class="ui-label cursor-pointer select-none">Details</summary>
    <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm">
      <dt class="text-muted">Peers reachable</dt>
      <dd>${status.peers}</dd>
      <dt class="text-muted">Photos</dt>
      <dd>${status.photos}</dd>
      <dt class="text-muted">Members</dt>
      <dd>${status.members.length}</dd>
    </dl>
    <dl class="mt-3 space-y-1 break-all font-mono">
      <dt>Drive key</dt>
      <dd>${status.folder.driveKey || status.driveKey}</dd>
      <dt>Discovery key</dt>
      <dd>${status.discoveryKey}</dd>
      <dt>Share key</dt>
      <dd>${status.folder.shareKey}</dd>
    </dl>
  </details>`;
}

function albumBody(id: string, vm: PeopleVm, syncVm: ReturnType<typeof $syncViewModel.get>) {
  const { status, state, busy, error, fatal } = syncVm;
  const back = html`<a class="text-sm text-muted hover:text-fg" href="/albums">← Albums</a>`;
  if (!status || status.folder.id !== id) {
    return html`<div class="max-w-2xl space-y-4">
      ${back}
      ${
        state === "ok" || state === "error"
          ? html`<p class="text-fg">This album isn't showing right now.</p>
              <button class="ui-btn-primary" @click=${() => folders.switchTo(id)}>
                Open album
              </button>`
          : html`<p class="text-muted">Loading…</p>`
      }
    </div>`;
  }
  return html`<div class="max-w-2xl space-y-5">
    ${back}
    <div class="flex items-center justify-between gap-3">
      <h1 class="min-w-0 truncate text-2xl font-semibold tracking-tight text-fg">
        ${status.folder.name}
      </h1>
      <span class="shrink-0 rounded-full bg-subtle px-2.5 py-1 text-xs font-semibold text-fg">
        ${roleLabel(status.folder.role)}
      </span>
    </div>
    ${errorBanner(
      error,
      state === "error" && !fatal ? () => sync.retry() : undefined,
      fatal ? () => window.location.reload() : undefined,
    )}
    ${requestsSection(vm)} ${membersSection(vm)} ${inviteSection(status)}
    ${enrollSection(status, state, busy)} ${detailsSection(status)}
  </div>`;
}

export function albumView(id: string) {
  return useStore($peopleViewModel, (vm) =>
    useStore($syncViewModel, (syncVm) => albumBody(id, vm, syncVm)),
  );
}
