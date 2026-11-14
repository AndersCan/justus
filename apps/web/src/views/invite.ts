import { html } from "lit-html";
import type { FolderSummary, InvitedFriend, SyncStatus } from "@justus/core";
import { watch } from "@mantaq/lit";
import { join, joinActor, joinViewOf } from "../machines/sharing/join-request";
import { people } from "../machines/people-machine";
import { friendlyError } from "../utils/friendly-error";
import { foldersActor } from "../machines/folders-machine";
import { syncActor } from "../machines/sync-machine";
import { buildInviteLink, ownerShown } from "../utils/invite-link";
import { qrPath } from "../utils/qr";
import { linkEndText } from "../utils/time";
import {
  inviteLink,
  inviteLinkActor,
  inviteLinkViewOf,
  type InviteLinkView,
} from "../machines/sharing/invite-link";
import { VALID_FOR_LABEL, type ValidFor } from "../machines/sharing/invite-link-machine";
import { friendChoices, type FriendChoice } from "../machines/sharing/add-friend-machine";
import { confirmAction } from "./confirm";
import { openAddFriend } from "./add-friend-sheet";
import { renderJoinSheet } from "./join-sheet";
import { toast } from "./toast";
import { gateway } from "../gateway";

import { copy, t } from "../copy/copy";
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The invite link for an album this phone made. Only the Admin's phone can
 * answer a request, so only the Admin's phone has a link; everyone else gets null. */
export function inviteLinkFor(
  folder: FolderSummary,
  myName: string,
  expiresAt: number,
): string | null {
  if (folder.role !== "creator" || !folder.invite) return null;
  return buildInviteLink({
    code: folder.invite.code,
    owner: folder.invite.owner,
    album: folder.name,
    ownerName: myName,
    expiresAt,
  });
}

/** Makes the album's link (or reuses the one already made) and returns it once its end time is saved. */
async function madeLink(folder: FolderSummary, myName: string): Promise<string | null> {
  inviteLink.createLink(folder.id, folder.invite?.code ?? "");
  await inviteLinkActor.settled();
  const view = inviteLinkViewOf(inviteLinkActor.snapshot());
  if (
    view.state !== "linkMade" ||
    view.folderId !== folder.id ||
    view.expiresAt === undefined ||
    view.code !== (folder.invite?.code ?? "")
  )
    return null;
  return inviteLinkFor(folder, myName, view.expiresAt);
}

function isStoreApp(): boolean {
  return (window as { BareShell?: boolean }).BareShell === true;
}

/** The store apps' WebViews have no Web Share, so they open the phone's own sheet. */
export function canShareInvite(): boolean {
  return isStoreApp() || typeof navigator.share === "function";
}

/** Phone's share sheet in the store apps, the browser's when it has one, otherwise copy. */
export async function shareInvite(folder: FolderSummary, myName: string) {
  const link = await madeLink(folder, myName);
  if (!link) return;
  const text = copy("invite.ask_to_join_my_justus", { name: folder.name, link });
  if (isStoreApp()) {
    // Closing the sheet looks like sending from it; the Copy button is the fallback.
    await gateway.share.send(text);
    return;
  }
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: copy("invite.justus_album", { name: folder.name }), text });
      return;
    } catch {
      // dismissed or failed: fall through to copy
    }
  }
  toast(
    (await copyText(link))
      ? copy("invite.invite_link_copied")
      : copy("invite.couldn_t_copy_the_invite"),
  );
}

async function copyInvite(folder: FolderSummary, myName: string, button: HTMLElement) {
  const link = await madeLink(folder, myName);
  if (!link) return;
  const ok = await copyText(link);
  if (!ok) {
    toast(copy("invite.couldn_t_copy_the_invite_2"));
    return;
  }
  const label = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = label;
  button.textContent = copy("invite.copied");
  const hint = button.parentElement?.parentElement
    ?.querySelector("[data-invite-hint]")
    ?.querySelector<HTMLElement>("[data-copy-id]");
  if (hint) {
    hint.dataset.text = hint.dataset.text ?? hint.textContent ?? "";
    hint.textContent = copy("invite.copied_paste_it");
  }
  setTimeout(() => {
    button.textContent = label;
    if (hint) hint.textContent = hint.dataset.text ?? "";
  }, 6000);
}

/** Copies the album's current link and says whether it worked; used by the toast after a removal. */
export async function copyInviteLink(folder: FolderSummary, myName: string) {
  const link = await madeLink(folder, myName);
  toast(
    link && (await copyText(link))
      ? copy("invite.invite_link_copied")
      : copy("invite.couldn_t_copy_the_invite_2"),
  );
}

async function turnOff(folder: FolderSummary) {
  if (!folder.invite) return;
  const ok = await confirmAction({
    title: copy("invite.turn_off_links_you_sent"),
    detail: copy("invite.links_you_sent_for_this"),
    confirmLabel: copy("invite.turn_off"),
    tone: "danger",
  });
  if (ok) inviteLink.turnOffLink(folder.id, folder.invite.code);
}

function qrCode(link: string) {
  const { size, d } = qrPath(link);
  return html`<svg
    viewBox="-2 -2 ${size + 4} ${size + 4}"
    class="mx-auto h-48 w-48 rounded-xl bg-white"
    role="img"
    aria-label=${copy("invite.qr_code_for_the_invite")}
    shape-rendering="crispEdges"
  >
    <path d="${d}" fill="#000" />
  </svg>`;
}

/** The joiner's three words, optional, shown only if the Admin asks, in the waiting dialog and on the update screen; null until the stored ask has them. */
export function checkCodeLine(code: string | undefined, ownerName: string) {
  if (!code) return null;
  const owner = ownerShown(ownerName, "mid");
  return html`<p class="mt-3 text-sm text-muted">${t("invite.may_ask_you_for_these", { owner })}</p>
    <p class="mt-1 break-words text-lg font-semibold text-fg">${code}</p>`;
}

/** "From your friends: A, B or C. They get the invite in Justus, no link needed." Up to three names, then "or N more". */
export function friendNamesLine(choices: FriendChoice[]): string {
  const names = choices.map((c) => c.name);
  const shown =
    names.length <= 3
      ? names
      : [...names.slice(0, 3), copy("invite.more", { count: names.length - 3 })];
  const list =
    shown.length === 1
      ? shown[0]
      : copy("invite.or", { others: shown.slice(0, -1).join(", "), last: shown[shown.length - 1] });
  return copy("invite.from_your_friends_they_get", { list });
}

/** Shown to the Admin while friend invites wait for a friend to open Justus; null when none wait. */
export function waitingLine(waitingFor: string[] | undefined): string | null {
  if (!waitingFor || waitingFor.length === 0) return null;
  return copy("invite.waiting_for_friends");
}

/** The friends the Admin invited who are not in the album yet, each with a Take back button. An identity that already joined is left out. */
function invitedList(
  folder: FolderSummary,
  memberIdentities: string[],
  friends: Record<string, string>,
  busy: boolean,
  takeBackError: string | null,
) {
  const invited = (folder.invitedFriends ?? []).filter(
    (f: InvitedFriend) => !memberIdentities.includes(f.identity),
  );
  if (invited.length === 0 && !takeBackError) return null;
  return html`<div class="mt-4">
    ${
      invited.length === 0
        ? null
        : html`<h3 class="ui-label mb-1">${t("invite.invited_not_in_yet")}</h3>
            <ul class="divide-y divide-line">
              ${invited.map((f) => {
                const name = friends[f.identity];
                return html`<li class="flex items-center justify-between gap-2 py-2">
                  <span class="min-w-0 text-sm text-fg">
                    <span class="font-semibold">${name ?? t("invite.someone_you_invited")}</span>
                    <span class="text-muted"
                      >·
                      ${f.role === "member" ? t("albums.collaborator") : t("albums.viewer")}</span
                    >
                  </span>
                  <button
                    class="ui-btn-ghost shrink-0"
                    ?disabled=${busy}
                    aria-label=${
                      name
                        ? copy("invite.take_back_name_s_invite", { name })
                        : copy("invite.take_back_this_invite")
                    }
                    @click=${() => people.takeBackInvite(folder.id, f.identity, name ?? "")}
                  >
                    ${t("invite.take_back")}
                  </button>
                </li>`;
              })}
            </ul>`
    }
    ${
      takeBackError
        ? html`<p class="mt-2 text-xs text-danger-fg" role="alert">
            ${copy("invite.couldn_t_take_back_the_invite")} ${friendlyError(takeBackError)}
          </p>`
        : null
    }
  </div>`;
}

/** Invite surface: pick how long the link works, then one tap sends it (share
 * sheet, or copy where there is none). The link itself is never drawn; the QR,
 * for someone standing next to you, only after a tap and only once a link is made.
 * Only the Admin has a link; members are told who to ask. */
export function invitePanel(
  folder: FolderSummary,
  myName: string,
  admin: string,
  qrShown: boolean,
  onShowQr: () => void,
  memberIdentities: string[] = [],
  friends: Record<string, string> = {},
  busy = false,
  takeBackError: string | null = null,
) {
  if (folder.role !== "creator" || !folder.invite) {
    return html`
      <section class="ui-card p-5">
        <h2 class="ui-label mb-1">${t("invite.invite_people")}</h2>
        <p class="text-sm text-fg">
          ${t("invite.ask_for_the_invite_link", { admin, name: folder.name })}
        </p>
      </section>
    `;
  }
  return watch(inviteLinkActor, (snapshot) => {
    const view = inviteLinkViewOf(snapshot);
    const made =
      view.folderId === folder.id &&
      view.expiresAt !== undefined &&
      view.code === (folder.invite?.code ?? "")
        ? view
        : null;
    return invitePanelBody(
      folder,
      myName,
      view,
      made?.expiresAt ?? null,
      qrShown,
      onShowQr,
      memberIdentities,
      friends,
      busy,
      takeBackError,
    );
  });
}

function linkBlockedFor(folder: FolderSummary, view: InviteLinkView) {
  return view.state === "turningOff" || folder.invite?.code === view.offCode;
}

function inviteButtons(folder: FolderSummary, myName: string, blocked: boolean) {
  const copyClick = (e: Event) => void copyInvite(folder, myName, e.currentTarget as HTMLElement);
  return html`<div class="flex flex-wrap gap-2">
    ${
      canShareInvite()
        ? html`<button
              class="ui-btn-ghost"
              ?disabled=${blocked}
              @click=${() => void shareInvite(folder, myName)}
            >
              ${t("invite.send_invite_link")}
            </button>
            <button class="ui-btn-ghost" ?disabled=${blocked} @click=${copyClick}>
              ${t("invite.copy_link")}
            </button>`
        : html`<button class="ui-btn-ghost" ?disabled=${blocked} @click=${copyClick}>
            ${t("invite.copy_invite_link")}
          </button>`
    }
  </div>`;
}

/** The album's Send/Copy buttons with a line under them that Copy turns into the
 * "Copied…" hint. Admin only: renders nothing for anyone else or without an invite code. */
export function inviteRow(folder: FolderSummary, myName: string, line: unknown) {
  if (folder.role !== "creator" || !folder.invite) return null;
  return watch(
    inviteLinkActor,
    (snapshot) => html`<div>
      ${inviteButtons(folder, myName, linkBlockedFor(folder, inviteLinkViewOf(snapshot)))}
      <p class="mt-1 text-xs text-muted" data-invite-hint>${line}</p>
    </div>`,
  );
}

function invitePanelBody(
  folder: FolderSummary,
  myName: string,
  view: InviteLinkView,
  expiresAt: number | null,
  qrShown: boolean,
  onShowQr: () => void,
  memberIdentities: string[],
  friends: Record<string, string>,
  busy: boolean,
  takeBackError: string | null,
) {
  // A friend who already holds an invite is listed under Invited, not offered again.
  const taken = [...memberIdentities, ...(folder.invitedFriends ?? []).map((f) => f.identity)];
  const choices = friendChoices(
    Object.entries(friends).map(([identity, name]) => ({ identity, name })),
    taken,
  );
  const waiting = waitingLine(folder.waitingFor);
  const link = expiresAt === null ? null : inviteLinkFor(folder, myName, expiresAt);
  // Until the album shows its new code, a fresh link would carry the one just turned off.
  const linksOff = view.offFolderId === folder.id;
  const replaced = view.replacedFolderId === folder.id;
  const linkBlocked = linkBlockedFor(folder, view);
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">${t("invite.invite_people")}</h2>
      ${
        replaced
          ? html`<p class="mb-4 text-sm text-fg" role="status">
              ${t("invite.link_replaced_by_removal", { name: view.removedName })}
            </p>`
          : null
      }
      ${
        linksOff
          ? html`<p class="mb-4 text-sm text-fg" role="status">
              ${t("invite.links_turned_off_links_you")}
            </p>`
          : null
      }
      ${
        choices.length === 0
          ? null
          : html`<button
                class="ui-btn-ghost mb-1"
                @click=${(e: Event) =>
                  openAddFriend(
                    e.currentTarget as HTMLElement,
                    { folderId: folder.id, albumName: folder.name },
                    friends,
                    taken,
                  )}
              >
                ${t("invite.add_a_friend")}
              </button>
              <p class="mb-4 text-sm text-muted">${friendNamesLine(choices)}</p>
              <h3 class="ui-label mb-1">${t("invite.or_send_a_link")}</h3>`
      }
      ${waiting ? html`<p class="mb-4 text-sm text-muted" role="status">${waiting}</p>` : null}
      <p class="mb-4 text-sm text-fg">
        ${t("invite.send_the_link_to_people", { name: folder.name })}
      </p>
      ${
        expiresAt === null
          ? html`<label class="mb-4 flex items-center gap-2 text-sm text-fg">
              ${t("invite.link_works_for")}
              <select
                class="ui-input w-auto py-1"
                @change=${(e: Event) =>
                  inviteLink.chooseLinkTime(
                    (e.currentTarget as HTMLSelectElement).value as ValidFor,
                  )}
              >
                ${(Object.keys(VALID_FOR_LABEL) as ValidFor[]).map(
                  (key) =>
                    html`<option value=${key} ?selected=${view.validFor === key}>
                      ${VALID_FOR_LABEL[key]}
                    </option>`,
                )}
              </select>
            </label>`
          : html`<p class="mb-4 text-sm text-fg">
              ${t("invite.this_link_works_until", { end: linkEndText(expiresAt) })}
            </p>`
      }
      ${inviteButtons(folder, myName, linkBlocked)}
      ${
        linkBlocked
          ? null
          : html`<p class="mt-2 text-sm text-muted" data-invite-hint>
              ${t("invite.send_it_in_any_chat")}
            </p>`
      }
      ${
        link === null
          ? null
          : qrShown
            ? html`<div class="mt-4">${qrCode(link)}</div>
                <p class="mt-2 text-center text-xs text-muted">
                  ${t("invite.they_scan_this_with_their")}
                </p>`
            : html`<button
                class="mt-3 text-sm text-muted underline underline-offset-2 hover:text-fg"
                @click=${onShowQr}
              >
                ${t("invite.with_them_now_show_a")}
              </button>`
      }
      ${invitedList(folder, memberIdentities, friends, busy, takeBackError)}
      ${
        linksOff
          ? null
          : html`<button
              class="mt-3 block text-sm text-muted underline underline-offset-2 hover:text-fg"
              ?disabled=${view.state === "turningOff"}
              @click=${() => void turnOff(folder)}
            >
              ${t("invite.turn_off_links_you_sent_2")}
            </button>`
      }
      <p class="mt-4 text-xs text-muted">${t("invite.both_of_you_need_justus")}</p>
    </section>
  `;
}

/** The joiner's screens: ask, waiting, not accepted. Rendered once, app-wide. */
export function joinSheet() {
  return watch(joinActor, (snapshot) => {
    const view = joinViewOf(snapshot);
    const { invite } = view;
    if (!invite) return renderJoinSheet(view, join);
    return renderJoinSheet(view, join, {
      asked: watch(foldersActor, (f) =>
        f.context.asks.some((a) => a.code === invite.code && !a.closed)
          ? html`<p class="mt-3 text-sm text-fg">
              ${t("join_request.your_request_wasn_t_answered")}
            </p>`
          : null,
      ),
      checkCode: watch(foldersActor, (f) =>
        checkCodeLine(
          f.context.asks.find((a) => a.code === invite.code)?.checkCode,
          invite.ownerName,
        ),
      ),
    });
  });
}

/** Who to name when waiting on the Admin: their name once known, else the role. */
export function adminName(status: AdminStatus | null | undefined): string {
  return knownAdminName(status) || copy("invite.the_admin");
}

type AdminStatus = { members: { admin: boolean; name: string }[] };

/** The Admin's name from the album's member list, or "" when the list has none yet. */
export function knownAdminName(status: AdminStatus | null | undefined): string {
  const name = status?.members.find((m) => m.admin)?.name;
  return name && name !== "Unknown device" ? name : "";
}

/** Shown on an album this device joined and the Admin hasn't approved yet:
 * it can already see the photos, but not add any. */
export function waitingForAdmin() {
  return watch(syncActor, (s) => pendingCard(s.context.status));
}

/** The warn card for a pending album, or null when the album is not pending. */
export function pendingCard(status: SyncStatus | null) {
  const admin = ownerShown(knownAdminName(status), "start");
  return status?.folder?.pending
    ? html`<div class="ui-card flex items-center gap-3 border-l-4 border-l-warn p-4" role="status">
        <span
          class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn motion-reduce:animate-none"
        ></span>
        <p class="text-sm text-fg">
          <span class="font-semibold">${t("invite.you_can_look_but_not")}</span>
          ${t("invite.needs_to_open_justus_to", { admin })}
        </p>
      </div>`
    : null;
}

/** Invites that reach the app from outside: a link opened by the host at cold
 * start (`window.__justusInvite`) or later (a `justus:invite` event). A link from the web
 * address opens first; the host's cold-start link, if any, replaces it while held. */
export function listenForHostInvites(addressLink?: string) {
  const w = window as unknown as { __justusInvite?: string };
  if (addressLink !== undefined) join.openLink(addressLink);
  if (w.__justusInvite) {
    join.openLink(w.__justusInvite);
    delete w.__justusInvite;
  }
  window.addEventListener("justus:invite", (e) => {
    const text = (e as CustomEvent<string>).detail;
    if (typeof text === "string") join.openLink(text);
  });
}
