import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type {
  AskSummary,
  DeletedAlbum,
  FolderSummary,
  JoinRequest,
  OfferSummary,
  Photo,
  ChangedRole,
  PhotoChanged,
  Role,
  SyncStatus,
} from "./types";

/** What `photos.add` takes besides the display copy at `path`. A host that
 * made the shared copies itself passes them here (see `PickedMedia`). */
export type AddExtras = {
  /** The thumbnail, staged next to the display copy. */
  thumb?: string;
  /** The untouched original: read for its hash and date taken, never shared. */
  original?: string;
  /** EXIF date taken, when the host read it (it can read HEIC; we can't). */
  takenAt?: string;
};

type AddArgs = { path?: string; name?: string; folderId?: string } & AddExtras;

/** Importing a photo (read + hash + put) can take a while. */
const PHOTOS_ADD_TIMEOUT_MS = 120_000;
/** list/status read every member's drive listing — network pulls can be slow. */
const PHOTOS_LIST_TIMEOUT_MS = 30_000;
/** remove/enroll/respond/create touch local drives — still, don't be stingy. */
const PHOTOS_SHORT_TIMEOUT_MS = 15_000;
/** offerAlbum waits up to 30 s for the friend's phone to answer. */
export const PHOTOS_OFFER_TIMEOUT_MS = 45_000;

export const photoSpecs = {
  list: {
    pluginId: "justus.photos",
    name: "photos.list",
    // `all`: every album's photos, newest first, instead of the active album's.
    args: {} as { all?: boolean },
    result: {} as { photos: Photo[] },
  },
  add: {
    pluginId: "justus.photos",
    name: "photos.add",
    // Either `path` (a file the host picked, already on disk) or `name`
    // (the original file name when the bytes travel in-band as the invoke
    // payload). The plugin picks whichever the caller provided. `folderId`
    // targets an album; without it the photo goes to the active album.
    args: {} as AddArgs,
    result: {} as Photo,
  },
  remove: {
    pluginId: "justus.photos",
    name: "photos.remove",
    args: {} as { id: string; folderId?: string },
    result: {} as { id: string },
  },
  join: {
    pluginId: "justus.photos",
    name: "photos.join",
    /** `name` is the album name from the invite: shown until the Admin's own
     * record replicates in. */
    args: {} as { key: string; name?: string },
    result: {} as SyncStatus,
  },
  enroll: {
    pluginId: "justus.photos",
    name: "photos.enroll",
    args: {} as { key: string; name: string },
    result: {} as SyncStatus,
  },
  status: {
    pluginId: "justus.photos",
    name: "photos.status",
    args: {} as Record<string, never>,
    result: {} as SyncStatus,
  },
  folders: {
    pluginId: "justus.photos",
    name: "photos.folders",
    args: {} as Record<string, never>,
    result: {} as {
      folders: FolderSummary[];
      /** Albums archived on this phone; they keep syncing. */
      archived: FolderSummary[];
      /** Albums the Admin deleted, until dismissed. */
      deleted: DeletedAlbum[];
      activeFolderId: string;
      asks: AskSummary[];
      offers: OfferSummary[];
    },
  },
  ask: {
    pluginId: "justus.photos",
    name: "photos.ask",
    args: {} as { code: string; owner: string; albumName?: string; ownerName?: string },
    result: {} as { ask: AskSummary },
  },
  createFolder: {
    pluginId: "justus.photos",
    name: "photos.createFolder",
    args: {} as { name: string },
    result: {} as { folder: FolderSummary },
  },
  setActive: {
    pluginId: "justus.photos",
    name: "photos.setActive",
    args: {} as { folderId: string },
    result: {} as SyncStatus,
  },
  setName: {
    pluginId: "justus.photos",
    name: "photos.setName",
    args: {} as { name: string },
    result: {} as { name: string },
  },
  requests: {
    pluginId: "justus.photos",
    name: "photos.requests",
    args: {} as Record<string, never>,
    result: {} as { requests: JoinRequest[] },
  },
  makeMember: {
    pluginId: "justus.photos",
    name: "photos.makeMember",
    args: {} as { folderId: string; memberKey: string },
    result: {} as { ok: boolean },
  },
  makeViewer: {
    pluginId: "justus.photos",
    name: "photos.makeViewer",
    args: {} as { folderId: string; memberKey: string },
    result: {} as { ok: boolean },
  },
  removeMember: {
    pluginId: "justus.photos",
    name: "photos.removeMember",
    args: {} as { folderId: string; memberKey: string },
    result: {} as { ok: boolean },
  },
  respond: {
    pluginId: "justus.photos",
    name: "photos.respond",
    args: {} as { folderId: string; requesterKey: string; approve: boolean; role?: Role },
    result: {} as { ok: boolean },
  },
  turnOffInvite: {
    pluginId: "justus.photos",
    name: "photos.turnOffInvite",
    args: {} as { folderId: string },
    result: {} as { invite: { code: string; owner: string } },
  },
  saveInviteLink: {
    pluginId: "justus.photos",
    name: "photos.saveInviteLink",
    args: {} as { folderId: string; expiresAt: number },
    result: {} as { ok: boolean },
  },
  offerAlbum: {
    pluginId: "justus.photos",
    name: "photos.offerAlbum",
    args: {} as { folderId: string; identity: string; role?: ChangedRole },
    result: {} as { ok: boolean; waiting?: boolean },
  },
  takeBackOffer: {
    pluginId: "justus.photos",
    name: "photos.takeBackOffer",
    args: {} as { folderId: string; identity: string },
    result: {} as { ok: boolean },
  },
  joinOffer: {
    pluginId: "justus.photos",
    name: "photos.joinOffer",
    args: {} as { code: string; owner: string },
    result: {} as { ask: AskSummary },
  },
  archiveAlbum: {
    pluginId: "justus.photos",
    name: "photos.archiveAlbum",
    args: {} as { folderId: string },
    result: {} as { ok: boolean },
  },
  restoreAlbum: {
    pluginId: "justus.photos",
    name: "photos.restoreAlbum",
    args: {} as { folderId: string },
    result: {} as { ok: boolean },
  },
  deleteAlbum: {
    pluginId: "justus.photos",
    name: "photos.deleteAlbum",
    args: {} as { folderId: string },
    result: {} as { ok: boolean },
  },
  leaveAlbum: {
    pluginId: "justus.photos",
    name: "photos.leaveAlbum",
    args: {} as { folderId: string },
    result: {} as { ok: boolean },
  },
  dismissAlbumNotice: {
    pluginId: "justus.photos",
    name: "photos.dismissAlbumNotice",
    args: {} as { folderId: string },
    result: {} as { ok: boolean },
  },
  dismissDeclinedAsk: {
    pluginId: "justus.photos",
    name: "photos.dismissDeclinedAsk",
    args: {} as { code: string },
    result: {} as { ok: boolean },
  },
  cancelAsk: {
    pluginId: "justus.photos",
    name: "photos.cancelAsk",
    args: {} as { code: string },
    result: {} as { ok: boolean },
  },
  linkTurnedOff: {
    pluginId: "justus.photos",
    name: "photos.linkTurnedOff",
    args: {} as { code: string; owner: string },
    result: {} as { turnedOff: boolean },
  },
  changed: {
    pluginId: "justus.photos",
    name: "photos.changed",
    args: {} as PhotoChanged,
    result: {} as never,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const photoEvents = {
  photos: {
    list(all?: boolean): InvokeEnvelope<"photos.list", { all?: boolean }, { photos: Photo[] }> {
      return invokeEvent(photoSpecs.list, all ? { all } : {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
    add(
      path: string,
      name?: string,
      folderId?: string,
      extras: AddExtras = {},
    ): InvokeEnvelope<"photos.add", AddArgs, Photo> {
      return invokeEvent(
        photoSpecs.add,
        { path, ...(name ? { name } : {}), ...(folderId ? { folderId } : {}), ...extras },
        null,
        PHOTOS_ADD_TIMEOUT_MS,
      );
    },
    remove(
      id: string,
      folderId?: string,
    ): InvokeEnvelope<"photos.remove", { id: string; folderId?: string }, { id: string }> {
      return invokeEvent(
        photoSpecs.remove,
        folderId ? { id, folderId } : { id },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    enroll(
      key: string,
      name: string,
    ): InvokeEnvelope<"photos.enroll", { key: string; name: string }, SyncStatus> {
      return invokeEvent(photoSpecs.enroll, { key, name }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    status(): InvokeEnvelope<"photos.status", Record<string, never>, SyncStatus> {
      return invokeEvent(photoSpecs.status, {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
    folders(): InvokeEnvelope<
      "photos.folders",
      Record<string, never>,
      {
        folders: FolderSummary[];
        archived: FolderSummary[];
        deleted: DeletedAlbum[];
        activeFolderId: string;
        asks: AskSummary[];
        offers: OfferSummary[];
      }
    > {
      return invokeEvent(photoSpecs.folders, {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
    ask(
      code: string,
      owner: string,
      albumName?: string,
      ownerName?: string,
    ): InvokeEnvelope<
      "photos.ask",
      { code: string; owner: string; albumName?: string; ownerName?: string },
      { ask: AskSummary }
    > {
      return invokeEvent(
        photoSpecs.ask,
        { code, owner, albumName, ownerName },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    createFolder(
      name: string,
    ): InvokeEnvelope<"photos.createFolder", { name: string }, { folder: FolderSummary }> {
      return invokeEvent(photoSpecs.createFolder, { name }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    setActive(
      folderId: string,
    ): InvokeEnvelope<"photos.setActive", { folderId: string }, SyncStatus> {
      return invokeEvent(photoSpecs.setActive, { folderId }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    setName(name: string): InvokeEnvelope<"photos.setName", { name: string }, { name: string }> {
      return invokeEvent(photoSpecs.setName, { name }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    requests(): InvokeEnvelope<
      "photos.requests",
      Record<string, never>,
      { requests: JoinRequest[] }
    > {
      return invokeEvent(photoSpecs.requests, {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
    makeMember(
      folderId: string,
      memberKey: string,
    ): InvokeEnvelope<
      "photos.makeMember",
      { folderId: string; memberKey: string },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.makeMember,
        { folderId, memberKey },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    makeViewer(
      folderId: string,
      memberKey: string,
    ): InvokeEnvelope<
      "photos.makeViewer",
      { folderId: string; memberKey: string },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.makeViewer,
        { folderId, memberKey },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    removeMember(
      folderId: string,
      memberKey: string,
    ): InvokeEnvelope<
      "photos.removeMember",
      { folderId: string; memberKey: string },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.removeMember,
        { folderId, memberKey },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    respond(
      folderId: string,
      requesterKey: string,
      approve: boolean,
      role?: Role,
    ): InvokeEnvelope<
      "photos.respond",
      { folderId: string; requesterKey: string; approve: boolean; role?: Role },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.respond,
        role === undefined
          ? { folderId, requesterKey, approve }
          : { folderId, requesterKey, approve, role },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    turnOffInvite(
      folderId: string,
    ): InvokeEnvelope<
      "photos.turnOffInvite",
      { folderId: string },
      { invite: { code: string; owner: string } }
    > {
      return invokeEvent(photoSpecs.turnOffInvite, { folderId }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    saveInviteLink(
      folderId: string,
      expiresAt: number,
    ): InvokeEnvelope<
      "photos.saveInviteLink",
      { folderId: string; expiresAt: number },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.saveInviteLink,
        { folderId, expiresAt },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    offerAlbum(
      folderId: string,
      identity: string,
      role?: ChangedRole,
    ): InvokeEnvelope<
      "photos.offerAlbum",
      { folderId: string; identity: string; role?: ChangedRole },
      { ok: boolean; waiting?: boolean }
    > {
      return invokeEvent(
        photoSpecs.offerAlbum,
        role === undefined ? { folderId, identity } : { folderId, identity, role },
        null,
        PHOTOS_OFFER_TIMEOUT_MS,
      );
    },
    takeBackOffer(
      folderId: string,
      identity: string,
    ): InvokeEnvelope<
      "photos.takeBackOffer",
      { folderId: string; identity: string },
      { ok: boolean }
    > {
      return invokeEvent(
        photoSpecs.takeBackOffer,
        { folderId, identity },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    joinOffer(
      code: string,
      owner: string,
    ): InvokeEnvelope<"photos.joinOffer", { code: string; owner: string }, { ask: AskSummary }> {
      return invokeEvent(photoSpecs.joinOffer, { code, owner }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    archiveAlbum(
      folderId: string,
    ): InvokeEnvelope<"photos.archiveAlbum", { folderId: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.archiveAlbum, { folderId }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    restoreAlbum(
      folderId: string,
    ): InvokeEnvelope<"photos.restoreAlbum", { folderId: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.restoreAlbum, { folderId }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    deleteAlbum(
      folderId: string,
    ): InvokeEnvelope<"photos.deleteAlbum", { folderId: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.deleteAlbum, { folderId }, null, PHOTOS_OFFER_TIMEOUT_MS);
    },
    leaveAlbum(
      folderId: string,
    ): InvokeEnvelope<"photos.leaveAlbum", { folderId: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.leaveAlbum, { folderId }, null, PHOTOS_OFFER_TIMEOUT_MS);
    },
    dismissAlbumNotice(
      folderId: string,
    ): InvokeEnvelope<"photos.dismissAlbumNotice", { folderId: string }, { ok: boolean }> {
      return invokeEvent(
        photoSpecs.dismissAlbumNotice,
        { folderId },
        null,
        PHOTOS_SHORT_TIMEOUT_MS,
      );
    },
    dismissDeclinedAsk(
      code: string,
    ): InvokeEnvelope<"photos.dismissDeclinedAsk", { code: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.dismissDeclinedAsk, { code }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    cancelAsk(code: string): InvokeEnvelope<"photos.cancelAsk", { code: string }, { ok: boolean }> {
      return invokeEvent(photoSpecs.cancelAsk, { code }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    linkTurnedOff(
      code: string,
      owner: string,
    ): InvokeEnvelope<
      "photos.linkTurnedOff",
      { code: string; owner: string },
      { turnedOff: boolean }
    > {
      return invokeEvent(photoSpecs.linkTurnedOff, { code, owner }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
  },
} as const;
