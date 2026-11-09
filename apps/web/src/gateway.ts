import {
  createPluginBus,
  createProtocolMessenger,
  MessageType,
  type InvokeEnvelope,
} from "@ekrooh/bare/core";
import {
  photoEvents,
  logEvents,
  friendEvents,
  grantEvents,
  justusLockEvents,
  justusShareEvents,
  justusMediaEvents,
  type AddExtras,
  type LogLevel,
} from "@justus/core";
import { guardResult } from "./contract-guard";
import { getTransport } from "./transport";
import { workletBase } from "./utils/peer";
import { encodePhoto } from "./utils/encode-photo";

export const transport = getTransport();

export const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});

// Subscribed here, not in main.ts: the dev server evaluates main.ts after the
// first requests (friends, join requests) went out, and a reply that lands
// before a listener exists is lost, so those calls time out.
transport.subscribe((message) => messenger.handleIncoming(message.header));

export const bus = createPluginBus(messenger);

/** `bus.invoke` with every `justus.photos` result checked against the shared
 * backend/web contract (see `contract-guard.ts`). */
async function invoke<R>(envelope: InvokeEnvelope<string, Record<string, unknown>, R>) {
  return guardResult(envelope, await bus.invoke(envelope));
}

/** The plugin-invoke shell the mantaq actors drive. Every call returns the
 * framework's `Either` tuple `[error, result]`. */
export const gateway = {
  /** Every album's photos, newest first. */
  list: () => invoke(photoEvents.photos.list(true)),
  add: (path: string, name?: string, folderId?: string, extras?: AddExtras) =>
    invoke(photoEvents.photos.add(path, name, folderId, extras)),
  /** Adds a photo from bytes picked in the browser (multi-file upload). */
  addFile: (name: string, bytes: Uint8Array | ArrayBuffer) =>
    invoke(photoEvents.photos.addFile(name, bytes)),
  /** Encodes a browser-picked file into the copies an album shares and posts
   * them to the worklet's `POST /photos` route (same-origin in the WebView,
   * Vite-proxied in dev): the thumbnail, then the display copy, in one body.
   * The original stays in the page. Same `Either` shape as an invoke; the
   * route answers with the stored (or deduped) photo's id. */
  upload: async (
    file: File,
    folderId?: string,
  ): Promise<[Error | null, { id?: string } | null]> => {
    try {
      const photo = await encodePhoto(file);
      const query = new URLSearchParams({
        filename: photo.filename,
        name: file.name,
        thumb: String(photo.thumb.size),
        ...(folderId ? { folder: folderId } : {}),
        ...(photo.sha256 ? { sha256: photo.sha256 } : {}),
        ...(photo.takenAt ? { takenAt: photo.takenAt } : {}),
      });
      const response = await fetch(`${workletBase()}/photos?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([photo.thumb, photo.display]),
      });
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        error?: string;
      } | null;
      if (!response.ok) return [new Error(body?.error ?? `HTTP ${response.status}`), null];
      return [null, { id: body?.id }];
    } catch (e) {
      return [e instanceof Error ? e : new Error(String(e)), null];
    }
  },
  remove: (id: string, folderId?: string) => invoke(photoEvents.photos.remove(id, folderId)),
  join: (key: string, name?: string) => invoke(photoEvents.photos.join(key, name)),
  enroll: (key: string, name: string) => invoke(photoEvents.photos.enroll(key, name)),
  status: () => invoke(photoEvents.photos.status()),
  folders: () => invoke(photoEvents.photos.folders()),
  /** Asks the album's Admin to let this phone in, from a link's code, owner and name hints. */
  ask: (code: string, owner: string, albumName?: string, ownerName?: string) =>
    invoke(photoEvents.photos.ask(code, owner, albumName, ownerName)),
  /** Whether the link's owner turned it off, read from the owner's phone within a few seconds. */
  linkTurnedOff: (code: string, owner: string) =>
    invoke(photoEvents.photos.linkTurnedOff(code, owner)),
  createFolder: (name: string) => invoke(photoEvents.photos.createFolder(name)),
  setActive: (folderId: string) => invoke(photoEvents.photos.setActive(folderId)),
  setName: (name: string) => invoke(photoEvents.photos.setName(name)),
  requests: () => invoke(photoEvents.photos.requests()),
  respond: (folderId: string, requesterKey: string, approve: boolean, role?: "reader" | "member") =>
    invoke(photoEvents.photos.respond(folderId, requesterKey, approve, role)),
  turnOffInvite: (folderId: string) => invoke(photoEvents.photos.turnOffInvite(folderId)),
  saveInviteLink: (folderId: string, expiresAt: number) =>
    invoke(photoEvents.photos.saveInviteLink(folderId, expiresAt)),
  /** Asks a saved friend's phone, by key alone, to offer them the album; they join as a Viewer (`reader`) or Collaborator (`member`). Fails with FRIEND_REFUSED or FRIEND_UNREACHABLE. */
  takeBackOffer: (folderId: string, identity: string) =>
    invoke(photoEvents.photos.takeBackOffer(folderId, identity)),
  offerAlbum: (folderId: string, identity: string, role: "reader" | "member") =>
    invoke(photoEvents.photos.offerAlbum(folderId, identity, role)),
  /** Joins the album a friend's invite offers; the Admin's phone lets this phone in without an Accept step. */
  joinOffer: (code: string, owner: string) => invoke(photoEvents.photos.joinOffer(code, owner)),
  /** Hides an album on this phone only; it keeps syncing. */
  archiveAlbum: (folderId: string) => invoke(photoEvents.photos.archiveAlbum(folderId)),
  restoreAlbum: (folderId: string) => invoke(photoEvents.photos.restoreAlbum(folderId)),
  /** Takes the album and the photos this phone added off the phone; the Admin cannot leave. */
  leaveAlbum: (folderId: string) => invoke(photoEvents.photos.leaveAlbum(folderId)),
  /** Admin only: removes the album and every photo in it from every member's phone. */
  deleteAlbum: (folderId: string) => invoke(photoEvents.photos.deleteAlbum(folderId)),
  dismissAlbumNotice: (folderId: string) => invoke(photoEvents.photos.dismissAlbumNotice(folderId)),
  /** Takes a declined request off this phone. */
  dismissDeclinedAsk: (code: string) => invoke(photoEvents.photos.dismissDeclinedAsk(code)),
  cancelAsk: (code: string) => invoke(photoEvents.photos.cancelAsk(code)),
  makeMember: (folderId: string, memberKey: string) =>
    invoke(photoEvents.photos.makeMember(folderId, memberKey)),
  /** Admin only: turns a Collaborator into a Viewer; the photos they added stay. */
  makeViewer: (folderId: string, memberKey: string) =>
    invoke(photoEvents.photos.makeViewer(folderId, memberKey)),
  removeMember: (folderId: string, memberKey: string) =>
    invoke(photoEvents.photos.removeMember(folderId, memberKey)),
  /** Native-host pick/capture (`justus.media`): staged file paths. */
  media: {
    pickMany: () => invoke(justusMediaEvents.media.pickMany()),
    capture: () => invoke(justusMediaEvents.media.capture()),
  },
  share: {
    send: (text: string) => invoke(justusShareEvents.share.send(text)),
  },
  lock: {
    status: () => invoke(justusLockEvents.lock.status()),
    setEnabled: (enabled: boolean) => invoke(justusLockEvents.lock.setEnabled(enabled)),
  },
  logs: {
    view: (opts?: { tail?: number; level?: LogLevel; sources?: string[] }) =>
      invoke(logEvents.view(opts)),
    clear: () => invoke(logEvents.clear()),
  },
  friends: {
    list: () => invoke(friendEvents.list()),
    add: (identity: string, name: string) => invoke(friendEvents.add(identity, name)),
    rename: (identity: string, name: string) => invoke(friendEvents.rename(identity, name)),
    remove: (identity: string) => invoke(friendEvents.remove(identity)),
  },
  grants: {
    view: () => invoke(grantEvents.view()),
    grant: (peerId: string) => invoke(grantEvents.grant(peerId)),
    decline: (peerId: string) => invoke(grantEvents.decline(peerId)),
    revoke: (peerId: string) => invoke(grantEvents.revoke(peerId)),
    snooze: () => invoke(grantEvents.snooze()),
  },
};
