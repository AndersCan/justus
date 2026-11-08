import { html } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { watch } from "@mantaq/lit";
import { join, joinActor, joinViewOf } from "../machines/sharing/join-request";
import { EXPIRED_LINK, expiredBody } from "../machines/sharing/join-request-machine";
import { syncActor } from "../machines/sync-machine";
import { buildInviteLink } from "../utils/invite-link";
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
import { toast } from "./toast";

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

/** Makes the album's link (or reuses the one already made) and returns it. */
function madeLink(folder: FolderSummary, myName: string): string | null {
  inviteLink.createLink(folder.id, folder.invite?.code ?? "");
  const view = inviteLinkViewOf(inviteLinkActor.snapshot());
  if (view.expiresAt === undefined) return null;
  return inviteLinkFor(folder, myName, view.expiresAt);
}

/** Native share sheet when available, otherwise copy. */
export async function shareInvite(folder: FolderSummary, myName: string) {
  const link = madeLink(folder, myName);
  if (!link) return;
  const text = `Ask to join my Justus album “${folder.name}”: ${link}`;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: `Justus album “${folder.name}”`, text });
      return;
    } catch {
      // dismissed or failed: fall through to copy
    }
  }
  toast((await copyText(link)) ? "Invite link copied" : "Couldn't copy the invite");
}

async function copy(folder: FolderSummary, myName: string, button: HTMLElement) {
  const link = madeLink(folder, myName);
  if (!link) return;
  const ok = await copyText(link);
  if (!ok) {
    toast("Couldn't copy the invite link");
    return;
  }
  const label = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = label;
  button.textContent = "Copied ✓";
  setTimeout(() => {
    button.textContent = label;
  }, 2000);
}

async function turnOff(folder: FolderSummary) {
  if (!folder.invite) return;
  const ok = await confirmAction({
    title: "Turn off links you sent?",
    detail:
      "Links you sent for this album stop working at once. Requests from them you haven't answered disappear. People already in stay in. Your next invite makes a fresh link.",
    confirmLabel: "Turn off",
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
    aria-label="QR code for the invite"
    shape-rendering="crispEdges"
  >
    <path d="${d}" fill="#000" />
  </svg>`;
}

/** "From your friends: A, B or C. They get the invite in Justus, no link needed." Up to three names, then "or N more". */
export function friendNamesLine(choices: FriendChoice[]): string {
  const names = choices.map((c) => c.name);
  const shown = names.length <= 3 ? names : [...names.slice(0, 3), `${names.length - 3} more`];
  const list =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
  return `From your friends: ${list}. They get the invite in Justus, no link needed.`;
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
) {
  if (folder.role !== "creator" || !folder.invite) {
    return html`
      <section class="ui-card p-5">
        <h2 class="ui-label mb-1">Invite people</h2>
        <p class="text-sm text-fg">
          Ask ${admin} for the invite link to “${folder.name}”. Only ${admin} can let new people in.
        </p>
      </section>
    `;
  }
  return watch(inviteLinkActor, (snapshot) => {
    const view = inviteLinkViewOf(snapshot);
    const made = view.folderId === folder.id && view.expiresAt !== undefined ? view : null;
    return invitePanelBody(
      folder,
      myName,
      view,
      made?.expiresAt ?? null,
      qrShown,
      onShowQr,
      memberIdentities,
      friends,
    );
  });
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
) {
  const choices = friendChoices(
    Object.entries(friends).map(([identity, name]) => ({ identity, name })),
    memberIdentities,
  );
  // One coloured button: Add a friend when a friend can be added, else the link.
  const linkButton = choices.length === 0 ? "ui-btn-primary" : "ui-btn-ghost";
  const canShare = typeof navigator.share === "function";
  const link = expiresAt === null ? null : inviteLinkFor(folder, myName, expiresAt);
  // Until the album shows its new code, a fresh link would carry the one just turned off.
  const linkBlocked = view.state === "turningOff" || folder.invite?.code === view.offCode;
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Invite people</h2>
      ${
        choices.length === 0
          ? null
          : html`<button
                class="ui-btn-primary mb-1"
                @click=${(e: Event) =>
                  openAddFriend(
                    e.currentTarget as HTMLElement,
                    { folderId: folder.id, albumName: folder.name },
                    friends,
                    memberIdentities,
                  )}
              >
                Add a friend
              </button>
              <p class="mb-4 text-sm text-muted">${friendNamesLine(choices)}</p>
              <h3 class="ui-label mb-1">Or send a link</h3>`
      }
      <p class="mb-4 text-sm text-fg">
        Send the link to people you want in “${folder.name}”. They ask to join and you choose who
        gets in. They see no photos until you accept.
      </p>
      ${
        expiresAt === null
          ? html`<label class="mb-4 flex items-center gap-2 text-sm text-fg">
              Link works for
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
              This link works until ${linkEndText(expiresAt)}.
            </p>`
      }
      <div class="flex flex-wrap gap-2">
        ${
          canShare
            ? html`<button
                  class=${linkButton}
                  ?disabled=${linkBlocked}
                  @click=${() => void shareInvite(folder, myName)}
                >
                  Send invite link
                </button>
                <button
                  class="ui-btn-ghost"
                  ?disabled=${linkBlocked}
                  @click=${(e: Event) => void copy(folder, myName, e.currentTarget as HTMLElement)}
                >
                  Copy link
                </button>`
            : html`<button
                class=${linkButton}
                ?disabled=${linkBlocked}
                @click=${(e: Event) => void copy(folder, myName, e.currentTarget as HTMLElement)}
              >
                Copy invite link
              </button>`
        }
      </div>
      ${
        linkBlocked
          ? null
          : html`<p class="mt-2 text-sm text-muted">
              Send it in any chat. They need Justus installed.
            </p>`
      }
      ${
        link === null
          ? null
          : qrShown
            ? html`<div class="mt-4">${qrCode(link)}</div>
                <p class="mt-2 text-center text-xs text-muted">
                  They scan this with their phone's camera.
                </p>`
            : html`<button
                class="mt-3 text-sm text-muted underline underline-offset-2 hover:text-fg"
                @click=${onShowQr}
              >
                With them now? Show a QR code
              </button>`
      }
      <button
        class="mt-3 block text-sm text-muted underline underline-offset-2 hover:text-fg"
        ?disabled=${view.state === "turningOff"}
        @click=${() => void turnOff(folder)}
      >
        Turn off links you sent
      </button>
      <p class="mt-4 text-xs text-muted">
        Both of you need Justus open for a request to arrive. It shows up here for you to accept or
        decline.
      </p>
    </section>
  `;
}

function sheet(label: string, body: unknown, onDismiss: () => void) {
  return html`
    <div
      class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
      @click=${onDismiss}
    >
      <div
        class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-label=${label}
        @click=${(e: Event) => e.stopPropagation()}
      >
        ${body}
      </div>
    </div>
  `;
}

/** The joiner's screens: ask, waiting, not accepted. Rendered once, app-wide.
 * No photos or counts: the link carries only the names its sender typed. */
export function joinSheet() {
  return watch(joinActor, (snapshot) => {
    const { state, invite, error } = joinViewOf(snapshot);
    if (
      state === "noInviteOpen" ||
      state === "showingLinkProblem" ||
      state === "joinedAlbum" ||
      !invite
    )
      return null;
    const owner = invite.ownerName;
    if (state === "linkExpired") {
      return sheet(
        EXPIRED_LINK,
        html`<h3 class="break-words text-base font-semibold text-fg">${EXPIRED_LINK}</h3>
          <p class="mt-3 text-sm text-fg">${expiredBody(owner)}</p>
          <div class="mt-4 flex justify-end">
            <button class="ui-btn-primary" @click=${() => join.dismissExpired()}>OK</button>
          </div>`,
        () => join.dismissExpired(),
      );
    }
    if (state === "decidingToAsk" || state === "sendingRequest") {
      const sending = state === "sendingRequest";
      const title = `Ask to join “${invite.album}”?`;
      return sheet(
        title,
        html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
          <p class="mt-3 text-sm text-fg">
            ${owner} will see your name and can accept or decline. You'll see the photos if they
            accept.
          </p>
          ${error ? html`<p class="mt-2 text-xs text-danger-fg" role="alert">${error}</p>` : null}
          <div class="mt-4 flex justify-end gap-2">
            <button class="ui-btn-ghost" ?disabled=${sending} @click=${() => join.notNow()}>
              Not now
            </button>
            <button class="ui-btn-primary" ?disabled=${sending} @click=${() => join.askToJoin()}>
              ${sending ? "Asking…" : "Ask to join"}
            </button>
          </div>`,
        () => {
          if (!sending) join.notNow();
        },
      );
    }
    if (state === "waitingForAdminToAccept") {
      const title = `Waiting for ${owner}`;
      return sheet(
        title,
        html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
          <p class="mt-3 text-sm text-fg">
            Request to join sent to ${owner}. You'll see “${invite.album}” when accepted. ${owner}
            must be online too: keep Justus open on both phones.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="ui-btn-ghost" @click=${() => join.cancelRequest()}>
              Cancel request
            </button>
            <button class="ui-btn-primary" @click=${() => join.closeWaiting()}>Close</button>
          </div>`,
        () => join.closeWaiting(),
      );
    }
    const title = `${owner} didn't accept your request.`;
    return sheet(
      title,
      html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
        <p class="mt-3 text-sm text-fg">Nothing was shared with you.</p>
        <div class="mt-4 flex justify-end">
          <button class="ui-btn-primary" @click=${() => join.dismissDecline()}>OK</button>
        </div>`,
      () => join.dismissDecline(),
    );
  });
}

/** Who to name when waiting on the Admin: their name once known, else the role. */
export function adminName(status: { members: { admin: boolean; name: string }[] } | null): string {
  const name = status?.members.find((m) => m.admin)?.name;
  return name && name !== "Unknown device" ? name : "the Admin";
}

/** Shown on an album this device joined and the Admin hasn't approved yet:
 * it can already see the photos, but not add any. */
export function waitingForAdmin() {
  return watch(syncActor, (s) => {
    const status = s.context.status;
    const admin = adminName(status);
    return status?.folder?.pending
      ? html`<div
          class="ui-card flex items-center gap-3 border-l-4 border-l-warn p-4"
          role="status"
        >
          <span
            class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn motion-reduce:animate-none"
          ></span>
          <p class="text-sm text-fg">
            <span class="font-semibold">You can look, but not add photos yet.</span>
            ${admin === "the Admin" ? "The Admin, who started this album," : admin} needs to open
            Justus to approve you, so you may want to remind them.
          </p>
        </div>`
      : null;
  });
}

/** Invites that reach the app from outside: a link opened by the host at cold
 * start (`window.__justusInvite`) or later (a `justus:invite` event). */
export function listenForHostInvites() {
  const w = window as unknown as { __justusInvite?: string };
  if (w.__justusInvite) {
    join.openLink(w.__justusInvite);
    delete w.__justusInvite;
  }
  window.addEventListener("justus:invite", (e) => {
    const text = (e as CustomEvent<string>).detail;
    if (typeof text === "string") join.openLink(text);
  });
}
