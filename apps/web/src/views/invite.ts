import { html } from "lit-html";
import { atom } from "nanostores";
import type { FolderSummary } from "@justus/core";
import { $inviteViewModel, invites } from "../machines/invite-machine";
import { $syncStatus } from "../machines/sync-machine";
import { useStore } from "../use-store";
import { buildInvite } from "../utils/invite";
import { qrPath } from "../utils/qr";
import { toast } from "./toast";

/** Group a 64-char hex key as "8 groups of 8" — readable, copyable. */
export function groupKey(key: string): string {
  return key.replace(/(.{8})/g, "$1 ").trim();
}

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

const $copied = atom<"link" | "key" | null>(null);

async function copy(kind: "link" | "key", value: string) {
  const ok = await copyText(value);
  $copied.set(ok ? kind : null);
  setTimeout(() => $copied.set(null), 2000);
  if (!ok) toast("Couldn't copy. The invite is shown on screen.");
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

/** Invite surface: copyable link, QR for in person, and the raw key. */
export function invitePanel(folder: FolderSummary, myName: string) {
  const link = inviteLinkFor(folder, myName);
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Invite to “${folder.name}”</h2>
      <p class="mb-4 text-sm text-fg">
        ${
          folder.role === "creator"
            ? "Send the link or show the QR. You approve each person who asks to join."
            : "Anyone you invite asks to join, and the Admin approves them."
        }
      </p>
      <div class="flex flex-wrap gap-2">
        ${useStore(
          $copied,
          (copied) => html`
            <button class="ui-btn-primary" @click=${() => void copy("link", link)}>
              ${copied === "link" ? "Copied ✓" : "Copy invite link"}
            </button>
            ${
              typeof navigator.share === "function"
                ? html`<button
                    class="ui-btn-ghost"
                    @click=${() => void shareInvite(folder, myName)}
                  >
                    Share…
                  </button>`
                : null
            }
            <button class="ui-btn-ghost" @click=${() => void copy("key", folder.shareKey)}>
              ${copied === "key" ? "Copied ✓" : "Copy key"}
            </button>
          `,
        )}
      </div>
      <div class="mt-4">${qrCode(link)}</div>
      <p class="mt-2 text-center text-xs text-muted">Scan in person, or paste the key instead.</p>
      <div
        class="mt-3 rounded-2xl bg-subtle px-4 py-3 font-mono text-[11px] leading-relaxed tracking-widest text-fg"
      >
        ${groupKey(folder.shareKey)}
      </div>
    </section>
  `;
}

/** The consent text from the join flow (ui-ux-spec §2.3), shown before any
 * join request is sent. Rendered once, app-wide. */
export function inviteConsentSheet() {
  return useStore($inviteViewModel, ({ invite }) => {
    if (!invite) return null;
    const who = invite.admin ? `${invite.admin}’s` : "this";
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
            Joining means your device holds a copy of ${who} album’s photos. Everyone in it can see
            everything in it, past and future, and can see when you’re connected.
          </p>
          <p class="mt-2 text-sm text-muted">The Admin has to approve you before you’re in.</p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="ui-btn-ghost" @click=${() => invites.cancel()}>Cancel</button>
            <button class="ui-btn-primary" @click=${() => invites.confirm()}>Ask to join</button>
          </div>
        </div>
      </div>
    `;
  });
}

/** Shown on an album this device asked to join and the Admin hasn't approved. */
export function waitingForAdmin() {
  return useStore($syncStatus, (status) =>
    status?.folder?.pending
      ? html`<div
          class="ui-card flex items-center gap-3 border-l-4 border-l-warn p-4"
          role="status"
        >
          <span
            class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn motion-reduce:animate-none"
          ></span>
          <p class="text-sm text-fg">
            <span class="font-semibold">Waiting for the Admin to let you in.</span>
            The Admin is the person who started this album. They need to open Justus on their phone
            to approve you, so you may want to remind them.
          </p>
        </div>`
      : null,
  );
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
