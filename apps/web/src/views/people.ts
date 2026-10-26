import { html } from "lit-html";
import { computed } from "nanostores";
import { $peopleViewModel, people } from "../machines/people-machine";
import { requests } from "../machines/requests-machine";
import { $syncState, type SyncStateName } from "../machines/sync-machine";
import { useStore } from "../use-store";
import { avatarColor, initialsOf } from "../utils/avatar";
import { confirmAction } from "./confirm";
import { invitePanel } from "./invite";
import { toast } from "./toast";

// Refresh the inbox when the album state turns over (a join or an approval can
// change pending requests). Push-driven refreshes are handled in handle-message.
let seenSync: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenSync && state !== seenSync) requests.refresh();
  seenSync = state;
});

const $chip = computed($peopleViewModel, (vm) => ({
  chip: vm.chip,
  pending: vm.requests.length,
  hasAlbum: Boolean(vm.folder?.id),
  allHere: vm.total > 0 && vm.connectedCount === vm.total,
}));

/** Header chip next to the connection indicator: "● 3 of 5 connected". */
export function peopleChip() {
  return useStore($chip, (c) =>
    c.hasAlbum
      ? html`<button
          class="ui-focus relative inline-flex min-h-8 items-center gap-1.5 rounded-full bg-subtle px-2.5 text-xs text-fg"
          aria-label="People in this album: ${c.chip}"
          @click=${() => people.open()}
        >
          <span
            class="inline-block h-2 w-2 rounded-full ${c.allHere ? "bg-ok" : "bg-warn"}"
            aria-hidden="true"
          ></span>
          ${c.chip}
          ${
            c.pending > 0
              ? html`<span
                  class="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white"
                  aria-label="${c.pending} waiting for approval"
                  >${c.pending}</span
                >`
              : null
          }
        </button>`
      : null,
  );
}

function avatar(name: string) {
  return html`<span
    class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
    style="background:${avatarColor(name)}"
    aria-hidden="true"
    >${initialsOf(name)}</span
  >`;
}

type PeopleVm = ReturnType<typeof $peopleViewModel.get>;

function memberRow(vm: PeopleVm, p: PeopleVm["people"][number]) {
  return html`<li class="flex items-center gap-3 py-2">
    ${avatar(p.name)}
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

/** The People sheet: members and presence, Invite, and (Admin) requests + Remove. */
export function peopleSheet() {
  return useStore($peopleViewModel, (vm) => {
    if (!vm.open || !vm.folder) return null;
    return html`
      <div
        class="justus-backdrop fixed inset-0 z-30 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
        @click=${() => people.close()}
      >
        <div
          class="justus-sheet max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="People"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => e.key === "Escape" && people.close()}
        >
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold text-fg">People in “${vm.folder.name}”</h2>
            <button class="ui-btn-ghost" @click=${() => people.close()}>Done</button>
          </div>
          <p class="mt-1 text-xs text-muted">
            Connected means your device can reach them right now. Everyone in the album can see
            this.
          </p>
          ${vm.error ? html`<p class="mt-2 text-xs text-danger" role="alert">${vm.error}</p>` : null}
          ${
            vm.requests.length > 0
              ? html`<h3 class="ui-label mt-4">Waiting for your approval</h3>
                  <ul class="mt-2 space-y-2">
                    ${vm.requests.map((r) => requestRow(r))}
                  </ul>`
              : null
          }
          <h3 class="ui-label mt-4">Members</h3>
          <ul class="divide-y divide-line">
            ${vm.people.map((p) => memberRow(vm, p))}
          </ul>
          <div class="mt-4">${invitePanel(vm.folder, vm.myName)}</div>
        </div>
      </div>
    `;
  });
}
