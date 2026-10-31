import { html } from "lit-html";
import { atom } from "nanostores";
import type { FolderSummary } from "@justus/core";
import { $inviteViewModel, invites } from "../machines/invite-machine";
import { $syncStatus } from "../machines/sync-machine";
import { useStore } from "../use-store";
import { buildInvite } from "../utils/invite";
import { qrPath } from "../utils/qr";
import { toast } from "./toast";

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The invite link for a folder; the Admin's name is only known on the Admin's
 * own device, so other members' invites carry the album name and count alone. */
export function inviteLinkFor(folder: FolderSummary, myName: string): string {
  return buildInvite({
    key: folder.shareKey,
    name: folder.name,
    admin: folder.role === "creator" ? myName : undefined,
    members: folder.members,
  });
}

/** Native share sheet when available, otherwise copy. */
export async function shareInvite(folder: FolderSummary, myName: string) {
  const link = inviteLinkFor(folder, myName);
  const text = `Join my Justus album “${folder.name}”: ${link}`;
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

const $copied = atom(false);
const $qrShownFor = atom<string | null>(null);

async function copy(value: string) {
  const ok = await copyText(value);
  $copied.set(ok);
  setTimeout(() => $copied.set(false), 2000);
  if (!ok) toast("Couldn't copy the invite link");
}

/** Hide the QR again when the album page is left, so it isn't on screen later. */
export function hideInviteQr() {
  $qrShownFor.set(null);
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

/** Invite surface: one tap sends the link (share sheet, or copy where there is
 * none). The link itself is never drawn; the QR, for someone standing next to
 * you, only after a tap. The raw share key lives under Advanced. */
export function invitePanel(folder: FolderSummary, myName: string) {
  const link = inviteLinkFor(folder, myName);
  const canShare = typeof navigator.share === "function";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Invite people</h2>
      <p class="mb-4 text-sm text-fg">
        Send the link to people you want in “${folder.name}”. Anyone with it can see every photo, so
        don't post it in public.
      </p>
      ${useStore(
        $copied,
        (copied) => html`<div class="flex flex-wrap gap-2">
          ${
            canShare
              ? html`<button
                    class="ui-btn-primary"
                    @click=${() => void shareInvite(folder, myName)}
                  >
                    Send invite link
                  </button>
                  <button class="ui-btn-ghost" @click=${() => void copy(link)}>
                    ${copied ? "Copied ✓" : "Copy link"}
                  </button>`
              : html`<button class="ui-btn-primary" @click=${() => void copy(link)}>
                  ${copied ? "Copied ✓" : "Copy invite link"}
                </button>`
          }
        </div>`,
      )}
      ${useStore($qrShownFor, (shown) =>
        shown === folder.id
          ? html`<div class="mt-4">${qrCode(link)}</div>
              <p class="mt-2 text-center text-xs text-muted">
                They scan this with their phone's camera.
              </p>`
          : html`<button
              class="mt-3 text-sm text-muted underline underline-offset-2 hover:text-fg"
              @click=${() => $qrShownFor.set(folder.id)}
            >
              With them now? Show a QR code
            </button>`,
      )}
      <p class="mt-4 text-xs text-muted">
        They can see the photos right away.
        ${
          folder.role === "creator"
            ? "You choose who can add their own photos: their request shows up here."
            : "The Admin chooses who can add their own photos."
        }
      </p>
    </section>
  `;
}

/** The consent text from the join flow (ui-ux-spec §2.3), shown before any
 * join request is sent. Rendered once, app-wide. */
export function inviteConsentSheet() {
  return useStore($inviteViewModel, ({ invite }) => {
    if (!invite) return null;
    const title = invite.name ? `Join “${invite.name}”?` : "Join this album?";
    const meta = [
      invite.admin ? `Admin: ${invite.admin}` : null,
      invite.members != null ? `${invite.members} member${invite.members === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return html`
      <div
        class="justus-backdrop fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
        @click=${() => invites.cancel()}
      >
        <div
          class="justus-sheet w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-2xl"
          role="dialog"
          aria-modal="true"
          aria-label=${title}
          @click=${(e: Event) => e.stopPropagation()}
        >
          <h3 class="break-words text-base font-semibold text-fg">${title}</h3>
          ${meta.length > 0 ? html`<p class="mt-1 text-xs text-muted">${meta.join(" · ")}</p>` : null}
          <p class="mt-3 text-sm text-fg">
            You’ll see every photo in this album, old and new, and a copy is kept on this phone.
            People in the album can see when you have Justus open.
          </p>
          <p class="mt-2 text-sm text-muted">
            To add your own photos, ${invite.admin ?? "the Admin"} needs to approve you.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="ui-btn-ghost" @click=${() => invites.cancel()}>Cancel</button>
            <button class="ui-btn-primary" @click=${() => invites.confirm()}>Join album</button>
          </div>
        </div>
      </div>
    `;
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
  return useStore($syncStatus, (status) => {
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
    invites.receive(w.__justusInvite);
    delete w.__justusInvite;
  }
  window.addEventListener("justus:invite", (e) => {
    const text = (e as CustomEvent<string>).detail;
    if (typeof text === "string") invites.receive(text);
  });
}
