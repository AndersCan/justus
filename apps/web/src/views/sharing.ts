import { html } from "lit-html";
import type { GrantRecord } from "@justus/core";
import { watch } from "@mantaq/lit";
import { foldersActor } from "../machines/folders-machine";
import { requestsActor } from "../machines/requests-machine";
import { grants, grantsActor, grantsViewModel } from "../machines/grants-machine";
import { albumsPanel, joinPanel, pendingAsks } from "./albums";
import { errorBanner } from "./error-banner";
import { tabs } from "./tabs";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
/** Short, copy-stable label for a device key — never the full peer id. */
function shortPeer(peerId: string): string {
  if (peerId.length <= 10) return peerId;
  return `${peerId.slice(0, 6)}…${peerId.slice(-4)}`;
}

/** Trust-surface signal: a peer that presented a verified signed invite receipt
 * (GrantRecord.receipt is set) is cryptographically known — not just a key we
 * typed. Returns the badge copy, or null when the record carries no receipt. */
export function inviteProvenance(record: GrantRecord): string | null {
  return record.receipt ? copy("sharing.verified_invite") : null;
}

/** Honest one-line state for a ledger record (share-grant-spec §2.1 / §4). */
function stateBadge(record: GrantRecord): { copy: string; cls: string } {
  if (record.serveTo === "granted") return { copy: copy("sharing.sharing"), cls: "text-ok-fg" };
  if (record.serveTo === "revoked")
    return { copy: copy("sharing.sharing_stopped"), cls: "text-danger-fg" };
  if (record.serveTo === "declined") return { copy: copy("sharing.said_no"), cls: "text-muted" };
  if (record.invitedBy) return { copy: copy("sharing.invited_you"), cls: "text-fg" };
  if (record.unknownHolderSince != null)
    return { copy: copy("sharing.asked_to_share"), cls: "text-muted" };
  return { copy: copy("sharing.not_sharing"), cls: "text-muted" };
}

type SharingViewModel = ReturnType<typeof grantsViewModel>;

function promptCard(view: SharingViewModel, record: GrantRecord) {
  return html`
    <li class="ui-card flex flex-col gap-3 border-l-4 border-l-warn p-5">
      <p class=" text-lg text-fg">${t("sharing.someone_with_one_of_your")}</p>
      <p class="text-sm text-muted">${t("sharing.device", { device: shortPeer(record.peerId) })}</p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="ui-btn-ghost font-semibold"
          ?disabled=${view.acting}
          @click=${() => {
            grants.snooze();
            toast(copy("sharing.we_ll_ask_another_day"));
          }}
        >
          ${t("sharing.not_now")}
        </button>
        <button
          class="ui-btn-primary"
          ?disabled=${view.acting}
          @click=${() => {
            grants.grant(record.peerId);
            toast(copy("sharing.sharing_with", { device: shortPeer(record.peerId) }));
          }}
        >
          ${t("sharing.share")}
        </button>
        <button
          class="ml-auto text-xs text-muted underline-offset-2 hover:text-danger-fg hover:underline"
          ?disabled=${view.acting}
          @click=${() => {
            grants.decline(record.peerId);
            toast(copy("sharing.you_won_t_be_asked", { device: shortPeer(record.peerId) }));
          }}
        >
          ${t("sharing.never_for_this_person")}
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
            ? html`<p class="text-xs text-muted">${t("sharing.they_keep_the_photos_they")}</p>`
            : null
        }
      </div>
      <div class="flex shrink-0 items-center gap-3">
        ${
          record.serveTo === "granted"
            ? html`<button
                class="text-xs text-muted underline-offset-2 hover:text-danger-fg hover:underline"
                ?disabled=${view.acting}
                @click=${() => {
                  grants.revoke(record.peerId);
                  toast(copy("sharing.stopped_sharing_with", { device: shortPeer(record.peerId) }));
                }}
              >
                ${t("sharing.stop_sharing")}
              </button>`
            : null
        }
        <span class="text-xs font-semibold ${badge.cls}">${badge.copy}</span>
        ${
          inviteProvenance(record)
            ? html`<span
                class="text-xs font-semibold text-ok-fg"
                title=${copy("sharing.this_device_presented_a_verified")}
                aria-label=${copy("sharing.verified_invite_2")}
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
      <p class="text-sm text-muted">${t("sharing.devices_that_hold_one_of")}</p>
      <button
        class="ui-btn-ghost shrink-0"
        ?disabled=${state === "loadingShareList" || state === "savingShareChoice"}
        @click=${() => grants.refresh()}
      >
        ${state === "loadingShareList" ? copy("sharing.refreshing") : copy("sharing.refresh")}
      </button>
    </div>

    ${errorBanner(
      error,
      state === "couldNotLoadShareList" && !fatal ? () => grants.retry() : undefined,
      fatal ? () => window.location.reload() : undefined,
    )}

    <section class="space-y-3">
      <h2 class="ui-label">${t("sharing.unknown_holder")}</h2>
      ${
        state === "shareListNotLoaded" ||
        (state === "loadingShareList" && view.dueRecords.length === 0)
          ? html`<p class="text-muted">${t("sharing.loading")}</p>`
          : view.dueRecords.length === 0
            ? html`
                <div class="ui-card p-5 text-center">
                  <p class=" text-lg text-fg">${t("sharing.no_prompts_right_now")}</p>
                  <p class="mt-1 text-sm text-fg">${t("sharing.we_ll_ask_once_a")}</p>
                </div>
              `
            : html`<ul class="space-y-3">
                ${view.dueRecords.map((r) => promptCard(view, r))}
              </ul>`
      }
    </section>

    <section class="space-y-3">
      <h2 class="ui-label">${t("sharing.who_you_share_with")}</h2>
      ${
        view.records.length === 0
          ? html`<p class="text-sm text-fg">${t("sharing.just_you_invite_someone_to")}</p>`
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
  return watch(grantsActor, (s) => devicesBody(grantsViewModel(s)));
}

/** Renders `view` with the number of things waiting for this person: join requests to answer plus friends' invites to join. */
export function waitingForYou<T>(view: (waiting: number) => T) {
  return watch(requestsActor, (q) =>
    watch(foldersActor, (f) => view(q.context.requests.length + f.context.offers.length)),
  );
}

export type SharingTab = "albums" | "join" | "devices";

/** Sharing: your albums' people and invites, and joining with an invite link.
 * The Devices ledger (`/devices`) is reachable by URL but not linked: choosing
 * who receives photos isn't enforced yet, so asking users about it would only
 * confuse them. Link it again once grants are live. */
export function sharingView(tab: SharingTab) {
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">${t("sharing.sharing_2")}</h1>
      ${waitingForYou((waiting) =>
        tabs(
          copy("sharing.sharing_2"),
          [
            {
              id: "albums",
              label: copy("sharing.your_albums"),
              href: "/sharing",
              badge: waiting,
            },
            { id: "join", label: copy("sharing.join_an_album"), href: "/join" },
            ...(tab === "devices"
              ? [{ id: "devices", label: copy("sharing.devices"), href: "/devices" }]
              : []),
          ],
          tab,
        ),
      )}
      ${tab === "albums" ? albumsPanel() : tab === "join" ? html`${pendingAsks()} ${joinPanel()}` : devicesPanel()}
    </div>
  `;
}
