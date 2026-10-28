import { html } from "lit-html";
import { computed } from "nanostores";
import type { GrantRecord } from "@justus/core";
import { $requests } from "../machines/requests-machine";
import { useStore } from "../use-store";
import { $grantsViewModel, grants } from "../machines/grants-machine";
import { albumsPanel, joinPanel } from "./albums";
import { errorBanner } from "./error-banner";
import { tabs } from "./tabs";
import { toast } from "./toast";

/** Short, copy-stable label for a device key — never the full peer id. */
function shortPeer(peerId: string): string {
  if (peerId.length <= 10) return peerId;
  return `${peerId.slice(0, 6)}…${peerId.slice(-4)}`;
}

/** Trust-surface signal: a peer that presented a verified signed invite receipt
 * (GrantRecord.receipt is set) is cryptographically known — not just a key we
 * typed. Returns the badge copy, or null when the record carries no receipt. */
export function inviteProvenance(record: GrantRecord): string | null {
  return record.receipt ? "verified invite" : null;
}

/** Honest one-line state for a ledger record (share-grant-spec §2.1 / §4). */
function stateBadge(record: GrantRecord): { copy: string; cls: string } {
  if (record.serveTo === "granted") return { copy: "Sharing ✓", cls: "text-ok" };
  if (record.serveTo === "revoked") return { copy: "Sharing stopped", cls: "text-danger" };
  if (record.serveTo === "declined") return { copy: "Said no", cls: "text-muted" };
  if (record.invitedBy) return { copy: "Invited you", cls: "text-fg" };
  if (record.unknownHolderSince != null) return { copy: "Asked to share", cls: "text-muted" };
  return { copy: "Not sharing", cls: "text-muted" };
}

type SharingViewModel = ReturnType<typeof $grantsViewModel.get>;

function promptCard(view: SharingViewModel, record: GrantRecord) {
  return html`
    <li class="ui-card flex flex-col gap-3 border-l-4 border-l-warn p-5">
      <p class=" text-lg text-fg">
        Someone with one of your album links joined. Share your photos with them?
      </p>
      <p class="text-sm text-muted">Device ${shortPeer(record.peerId)}</p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="ui-btn-ghost font-semibold"
          ?disabled=${view.acting}
          @click=${() => {
            grants.snooze();
            toast("We'll ask another day");
          }}
        >
          Not now
        </button>
        <button
          class="ui-btn-primary"
          ?disabled=${view.acting}
          @click=${() => {
            grants.grant(record.peerId);
            toast(`Sharing with ${shortPeer(record.peerId)}`);
          }}
        >
          Share
        </button>
        <button
          class="ml-auto text-xs text-muted underline-offset-2 hover:text-danger hover:underline"
          ?disabled=${view.acting}
          @click=${() => {
            grants.decline(record.peerId);
            toast(`You won't be asked about ${shortPeer(record.peerId)} again`);
          }}
        >
          never for this person
        </button>
      </div>
    </li>
  `;
}

function recordRow(view: SharingViewModel, record: GrantRecord) {
  const badge = stateBadge(record);
  return html`
    <li class="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <div class="min-w-0">
        <p class="truncate font-mono text-sm text-fg">${shortPeer(record.peerId)}</p>
        ${
          record.serveTo === "revoked"
            ? html`<p class="text-xs text-muted">
                They keep the photos they already have; they won't get new ones.
              </p>`
            : null
        }
      </div>
      <div class="flex shrink-0 items-center gap-3">
        ${
          record.serveTo === "granted"
            ? html`<button
                class="text-xs text-muted underline-offset-2 hover:text-danger hover:underline"
                ?disabled=${view.acting}
                @click=${() => {
                  grants.revoke(record.peerId);
                  toast(`Stopped sharing with ${shortPeer(record.peerId)}`);
                }}
              >
                stop sharing
              </button>`
            : null
        }
        <span class="text-xs font-semibold ${badge.cls}">${badge.copy}</span>
        ${
          inviteProvenance(record)
            ? html`<span
                class="text-xs font-semibold text-ok"
                title="This device presented a verified signed invite receipt."
                aria-label="Verified invite"
                >✓ ${inviteProvenance(record)}</span
              >`
            : null
        }
      </div>
    </li>
  `;
}

function devicesBody(view: SharingViewModel) {
  const { state, error, fatal } = view;
  return html`
    <div class="flex items-start justify-between gap-3">
      <p class="text-sm text-muted">
        Devices that hold one of your albums, and whether your device sends them photos.
      </p>
      <button
        class="ui-btn-ghost shrink-0"
        ?disabled=${state === "refreshing" || state === "acting"}
        @click=${() => grants.refresh()}
      >
        ${state === "refreshing" ? "Refreshing…" : "Refresh"}
      </button>
    </div>

    ${errorBanner(
      error,
      state === "error" && !fatal ? () => grants.retry() : undefined,
      fatal ? () => window.location.reload() : undefined,
    )}

    <section class="space-y-3">
      <h2 class="ui-label">Unknown holder</h2>
      ${
        state === "idle" || (state === "refreshing" && view.dueRecords.length === 0)
          ? html`<p class="text-muted">Loading…</p>`
          : view.dueRecords.length === 0
            ? html`
                <div class="ui-card p-5 text-center">
                  <p class=" text-lg text-fg">No prompts right now.</p>
                  <p class="mt-1 text-sm text-fg">
                    We'll ask once a day if someone shows up holding one of your albums without an
                    invite.
                  </p>
                </div>
              `
            : html`<ul class="space-y-3">
                ${view.dueRecords.map((r) => promptCard(view, r))}
              </ul>`
      }
    </section>

    <section class="space-y-3">
      <h2 class="ui-label">Who you share with</h2>
      ${
        view.records.length === 0
          ? html`<p class="text-sm text-fg">Just you — invite someone to share.</p>`
          : html`<ul class="ui-card divide-y divide-line px-5 py-1">
              ${view.records.map((r) => recordRow(view, r))}
            </ul>`
      }
    </section>
  `;
}

let started = false;

function devicesPanel() {
  if (!started) {
    started = true;
    grants.refresh();
  }
  return useStore($grantsViewModel, (vm) => devicesBody(vm));
}

export type SharingTab = "albums" | "join" | "devices";

const $sharingTabs = computed([$requests, $grantsViewModel], (reqs, grantsVm) => ({
  requests: reqs.length,
  prompts: grantsVm.dueRecords.length,
}));

/** Albums & sharing: manage albums, join with an invite, and see which
 * devices you share with — one page, three tabs. */
export function sharingView(tab: SharingTab) {
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Albums & sharing</h1>
      ${useStore($sharingTabs, (counts) =>
        tabs(
          "Albums and sharing",
          [
            { id: "albums", label: "Albums", href: "/sharing", badge: counts.requests },
            { id: "join", label: "Join an album", href: "/join" },
            { id: "devices", label: "Devices", href: "/devices", badge: counts.prompts },
          ],
          tab,
        ),
      )}
      ${tab === "albums" ? albumsPanel() : tab === "join" ? joinPanel() : devicesPanel()}
    </div>
  `;
}
