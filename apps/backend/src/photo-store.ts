import { compareGalleryOrder, deriveGallery, type DriveScan } from "./gallery-order";
import {
  DRIVE_PATH_PHOTOS,
  DRIVE_PATH_REMOVED,
  DRIVE_PATH_THUMBS,
  addPhoto,
  galleryDrives,
  listGallery,
} from "./photos/gallery";
import {
  addFormer,
  copyHeld,
  dropFormer,
  ensureHoldingMarker,
  holdersFor,
  markHeld,
  readFormer,
  readHeld,
  type FormerPerson,
  type HeldReport,
} from "./photos/holders";
import { RENDITION_EXT, isSha256Hex, readTakenAt, TAKEN_AT_RE } from "@justus/core";
import { createLazyMedia } from "./lazy-media";
import { pumpStream, type PumpWriter } from "./pump";
import type { Files, Paths } from "./ports/files";
import type { PeerEvent, PeerNetwork } from "./ports/peer-network";
import { guessMime } from "./mime";
import { spoolNameFor } from "./spool-name";
import type { LoopbackServer } from "@ekrooh/bare/runtime";
import { CoreError, ErrorCode, err, ok } from "@ekrooh/bare/core";
import { RealClock } from "@mantaq/core";
import { Either } from "@mantaq/utils";
import {
  createAlbumLifecycleActor,
  lifecycleStart,
  type AlbumLifecyclePort,
  type Keep,
} from "./albums/album-lifecycle-machine";
import {
  adminDroppedYou,
  clearLeftNote,
  deleteOwnPhotos,
  readDeleteNote,
  readLeftNote,
  writeDeleteNote,
  writeLeftNote,
} from "./albums/lifecycle";
import { addRemovedPerson, readRemovedPeople } from "./albums/removed-people";
import { PEER_PROTOCOL } from "./versions";
import { STATE_VERSION, stateVersionOf } from "./versions";
import { checkCode } from "./membership/check-code";
import { inviteTopic } from "./membership/invite";
import { makeMemberViewer, makeViewerMember, removeViewer, seatViewer } from "./membership/viewers";
import {
  DRIVE_PATH_MEMBERS,
  DRIVE_PATH_VIEWERS,
  DRIVE_PATH_REQUESTS,
  readViewers,
  openAlbum,
  pendingJoinRequests,
  acceptJoinRequest,
  readJoinRequests,
  writeJoinRequest,
  type FoundJoinRequest,
  openWithTopic,
  readRecord,
  readRegistry,
  type JoinPorts,
} from "./membership/join";
import type { Drive, DriveStore, OpenResult } from "./ports/drive-store";
import type { DriveEntry } from "./ports/drive-store";
import {
  DEFAULT_ASK_ALBUM,
  DEFAULT_ASK_OWNER,
  isEnrolled,
  isFriendMessageShape,
  isHexKey,
  isTextJSON,
  parseFriendMessage,
  type FriendMessage,
  type EarlierFile,
  type Answer,
  parseDeviceName,
  parseEarlier,
  parseRemoved,
  parseRequestsFile,
  invitesAsked,
  verifiedDeviceIdentity,
  identityMessage,
  peerName,
  CLOCK_SLACK_MS,
  inLinkTime,
  type EarlierEntry,
  type LinkTime,
  type RegistryFile,
  type ViewersFile,
  type RemovedFile,
} from "./membership/records";
import { copyOwnEntries, countShownPhotos, moveAlbum } from "./albums/move";
import {
  checkAsk,
  fileInviteAsk,
  offerAlbumTo,
  offerToTake,
  replyTo,
  tellIdentity,
  withdrawInvite,
  type InvitePorts,
} from "./membership/invites";
import {
  answersOwed,
  arrivingAnswer,
  type AskedCode,
  deliverOwed,
  forgetSent,
  proveIdentity,
} from "./membership/answers";
import {
  albumNameUpdate,
  albumSummary,
  createAlbumDrive,
  removeAlbumMember,
  rotateAlbum,
} from "./albums/albums";
import {
  createPresence,
  learnDevices,
  memberPresence,
  parseLastSeen,
  peerConnected,
  peerDisconnected,
  serializeLastSeen,
  type DeviceSource,
} from "./presence/presence";
import { createP2pLog, errText, short, type P2pLogSink } from "./p2p-log";
import {
  dropOwed,
  keepInvitedRoles,
  holdOffer,
  holdOwed,
  liveOwed,
  mayShowOfferFrom,
  OFFER_REACH_MS,
  OFFER_RESEND_MS,
  type OwedOffers,
} from "./membership/offers";

/**
 * Dependency-injection seam. `photo-store.ts` used to import the full p2p
 * stack (`bare-fs` / `bare-path` / `bare-crypto` and the drive storage)
 * at module top, which pulls in native addons and makes the module impossible
 * to load under Node/vitest (no Bare runtime). Those symbols are now injected
 * through {@link PhotoStoreDeps}, so the module loads without Bare and the
 * drives/swarm can be substituted with in-memory fakes in tests.
 * Production (`main.core.ts`) passes the real `bare-*` implementations; the
 * only behavior that changes is *where* the constructors are chosen.
 */
import type {
  AskSummary,
  OfferSummary,
  FolderNotice,
  DeletedAlbum,
  FolderSummary,
  JoinRequest,
  Photo,
  PhotoChanged,
  PhotoChangedCause,
  Role,
  SyncMember,
  SyncStatus,
} from "@justus/core";

/** Canonical app-scoped error codes (preserved verbatim on the wire). */
export const PhotoError = {
  NOT_A_MEMBER: "justus.photos/not-a-member",
  NOT_CREATOR: "justus.photos/not-creator",
  ALREADY_ENROLLED: "justus.photos/already-enrolled",
  NOT_FOUND: "justus.photos/not-found",
  INVALID_KEY: "justus.photos/invalid-key",
  FOLDER_NOT_FOUND: "justus.photos/folder-not-found",
  NAME_REQUIRED: "justus.photos/name-required",
  NO_ACTIVE_FOLDER: "justus.photos/no-active-folder",
  NOT_PENDING: "justus.photos/not-pending",
  FORBIDDEN: "justus.photos/import-path-forbidden",
  UNSUPPORTED_FORMAT: "justus.photos/unsupported-format",
  UPDATE_REQUIRED: "justus.photos/update-required",
  FRIEND_UNREACHABLE: "justus.photos/friend-unreachable",
  FRIEND_REFUSED: "justus.photos/friend-refused",
  OFFER_GONE: "justus.photos/offer-gone",
  OFFER_PENDING: "justus.photos/offer-pending",
  INVALID_ROLE: "justus.photos/invalid-role",
  VIEWER_NEEDS_INVITE: "justus.photos/viewer-needs-invite",
  ALBUM_ARCHIVED: "justus.photos/album-archived",
  ALBUM_NOT_CHANGED: "justus.photos/album-not-changed",
  ADMIN_CANNOT_LEAVE: "justus.photos/admin-cannot-leave",
  INVALID_LINK_TIME: "justus.photos/invalid-link-time",
} as const;

/** Success/failure tuple matching the framework's `Either<E, A>` union. */
type EitherResult<T> = [CoreError, null] | [null, T];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Persisted device state — now MULTI-folder. `name` is the settable user
 * name (surfaced via `status().name` and persisted to each drive's
 * `/device.json`). `folders` is the list of every folder this device belongs
 * to (creator, member or reader). `activeFolderId` points at the single
 * folder the gallery operates on; exactly one folder is active.
 */
type PersistedState = {
  name: string;
  folders: FolderRecord[];
  activeFolderId: string | null;
  asks: AskRecord[];
  /** Invites friends sent to this phone, not answered yet. */
  offers: OfferSummary[];
  /** Albums that left this phone's list, kept for what still has to be done or shown. */
  gone: GoneRecord[];
};

/** An album removed from this phone. `deletedForEveryone`: this phone is the
 * Admin's and keeps only the delete note, to offer it to members who were away.
 * `deletedByAdmin`: the Admin deleted it; the notice shows until dismissed.
 * `waitingForAdminToSeeYouLeft`: a Member or Viewer left; this phone's own drive in the
 * album (`selfNs`) keeps saying so until the Admin's list (`listedIn`) drops it. */
type GoneRecord = {
  id: string;
  name: string;
  shareKey: string;
  kind: "deletedForEveryone" | "deletedByAdmin" | "waitingForAdminToSeeYouLeft";
  selfNs?: string;
  /** Which Admin list the leaver was on; absent means `/members.json`. */
  listedIn?: "viewers";
  adminName?: string;
  at: number;
};

/** A request to join through an invite code. `shareKey` is set only once the
 * Admin accepted and the join is not done yet; it never touches a drive. */
type AskRecord = Omit<AskSummary, "status"> & {
  status: "waiting" | "declined" | "accepted" | "linkOff";
  shareKey?: string;
  /** Joining this ask's album replaces the album with this local id: the
   * Admin moved it to new keys and this phone is following. */
  replaces?: string;
};

type Answers = Record<string, "accepted" | "declined">;

/** Someone the album moved away from who has not arrived on the new key yet. */
type MovingEntry = { role: "member" | "reader"; name: string; key: string };

/** The album drive's list of earlier member drives (see `EarlierFile`). */
const DRIVE_PATH_EARLIER = "/earlier.json";

/** How many earlier keys of a moved album are kept for people still to follow. */
const MAX_PAST_KEYS = 10;
const MAX_LINK_TIMES = 50;
/** How many other people's drives a removed phone keeps at a fixed version. */
const MAX_KEPT_DRIVES = 200;
/** A link lasts at most 7 days; the slack covers clocks that differ. */
const MAX_LINK_MS = 7 * 24 * 60 * 60_000 + CLOCK_SLACK_MS;

/**
 * One folder this device holds. `id` is a stable local id (across sessions);
 * `shareKey` is the creator drive's key (hex), `driveKey` is the drive THIS
 * device writes within this folder (`""` for pure readers).
 */
type FolderRecord = {
  id: string;
  name: string;
  role: Role;
  /** True while this device's writer enrollment awaits the creator's approval
   * (a requested join). The device can still read by share key regardless. */
  pending?: boolean;
  shareKey: string;
  driveKey: string;
  createdAt: number;
  /** Creator: the album's own invite code. Joiner: the code it asked through. */
  invite?: { code: string; owner?: string; links?: LinkTime[] };
  /** Creator only: the answer given to each identity that asked. */
  answers?: Answers;
  /** Creator only: when the ask behind each "declined" answer was made. */
  declinedAsks?: Record<string, number>;
  /** Creator only: invite codes turned off. A joiner that asked through one
   * still gets its answer under that code. */
  retiredInvites?: string[];
  /** Creator: requests listed when a Remove retired their code, identity -> that code. Answering one clears it. */
  heldAsks?: Record<string, string>;
  /** Creator only: identities with an open friend invite to this album. */
  invited?: string[];
  /** Creator only: friend invites nobody answered yet, by identity, with when they started waiting. */
  offerOwed?: OwedOffers;
  /** Creator only: the role each friend with an open or waiting invite gets on Join. Missing = Collaborator (invites from before this field). */
  invitedRoles?: Record<string, "reader" | "member">;
  /** Corestore namespace of this device's drive in the album. Defaults to
   * `member/<shareKey>`; an album joined through an ask keeps `ask/<code>`. */
  selfNs?: string;
  /** Creator: when this album moved to a new key (the rerun guard). */
  rotatedAt?: number;
  /** Creator: the old member drives, kept as read-only photo sources. */
  earlier?: EarlierEntry[];
  /** Creator: the keys the album had before each move, newest first (at most 10). */
  pastKeys?: string[];
  /** Creator: how many times the album moved because someone was removed. */
  moves?: number;
  /** Creator: people who have not yet followed the album to its new key, by
   * identity, with the role they get and the drive and name they had. */
  moving?: Record<string, MovingEntry>;
  /** Creator: people who stayed after a Remove whose phone's identity this phone did not know yet, by drive key. Each moves to `moving` once the identity is learned. */
  movingUnknown?: Record<string, MovingEntry>;
  /** Creator: keys removed whose move to new keys has not finished; a retry
   * of Remove runs the move again. */
  moveOwed?: string[];
  /** Removed phone: the version of each other person's drive it keeps. */
  keptUntil?: Record<string, number>;
  /** Not creator: an album from before the key move; read-only. */
  moved?: true;
  notice?: FolderNotice;
  /** Absent: shown. `archived`: hidden on this phone, still synced. The other
   * two mark work that a restart must finish. */
  lifecycle?: "archived" | "leaving" | "deleting";
};

/** The copies an add brings besides the display copy (see `AddExtras` in
 * `@justus/core`): paths the host staged, or a hash/date the Web layer read. */
export type AddOptions = {
  thumb?: string;
  original?: string;
  sha256?: string;
  takenAt?: string;
};

export type PhotoStoreDeps = {
  storageDir: string;
  cacheDir: string;
  /** Allowed roots for `add(path)` imports (issue #93/#97). The native picker
   * copies selections into `cacheDir`, so that is the default; production may
   * pass additional roots if the picker is configured to write elsewhere. A
   * path that does not resolve inside one of these roots is rejected before any
   * bytes are read. */
  importRoots?: string[];
  server: LoopbackServer;
  /** This device's display name (persisted; defaults generated). */
  deviceName: string;
  /** Push a backend → web `photos.changed` dispatch. */
  onChanged: (change: PhotoChanged) => void;
  /** Dev only: a fresh install starts a "Sample photos" album, and every new
   * album gets sample photos. */
  seedOnEmpty: boolean;
  /** Filesystem access. Injected so the store loads under Node/vitest without
   * the Bare runtime; production passes `bare-fs`. */
  fs: Files;
  /** Path helpers. Injected; production passes `bare-path`. */
  path: Paths;
  /** Crypto helpers. Injected; production passes `bare-crypto`. */
  crypto: typeof import("bare-crypto");
  /** Where drives live (Corestore and Hyperdrive in production). */
  drives: DriveStore;
  /** True when `identity` is a saved friend. Only friends (and people already in an album together) can send this phone an invite. */
  isFriend?: (identity: string) => boolean;
  /** How long `offerAlbum` waits for the friend's phone. Defaults to {@link OFFER_REACH_MS}. */
  offerReachMs?: number;
  /** Peers: topics, connections, and the identity, version and answer channels. */
  network: PeerNetwork;
  /** Max ms to wait for a remote drive to become ready before giving up on it
   * (e.g. when reading a peer's join-request outbox in `requests()`). Defaults
   * to 45_000. Test seams lower it so latency regressions surface quickly. */
  driveOpenTimeoutMs?: number;
  /** Peer protocol this device announces. Tests only: plays a newer or older peer. */
  peerProtocol?: number;
  /** Receives structured p2p boundary events (see `p2p-log.ts`). Defaults to a
   * console line per event; tests inject a sink to assert on them. */
  log?: P2pLogSink;
};

export interface PhotoStore {
  ready(): Promise<void>;
  /** The active album's photos, or with `all` every album's, newest first. */
  list(opts?: { all?: boolean }): Promise<Photo[]>;
  /** `folderId` targets an album; without it the active album. `path` is the
   * display copy when `opts.thumb` is given, else a file shared as it is. */
  add(
    path: string,
    name?: string,
    folderId?: string,
    opts?: AddOptions,
  ): Promise<EitherResult<Photo>>;
  /** Adds a photo from in-band bytes (browser multi-file picker). */
  addBytes(name: string, bytes: Uint8Array, folderId?: string): Promise<EitherResult<Photo>>;
  remove(id: string, folderId?: string): Promise<EitherResult<{ id: string }>>;
  /** `nameHint` is the album name from the invite, used until the Admin's
   * `/folder.json` replicates in. */
  join(key: string, nameHint?: string): Promise<EitherResult<SyncStatus>>;
  enroll(key: string, name: string): Promise<EitherResult<SyncStatus>>;
  status(): Promise<SyncStatus>;
  folders(): Promise<{
    folders: FolderSummary[];
    archived: FolderSummary[];
    deleted: DeletedAlbum[];
    activeFolderId: string;
    asks: AskSummary[];
    offers: OfferSummary[];
  }>;
  /** Asks the Admin behind an invite code to let this device in. The album's
   * key reaches this device only after the Admin accepts. */
  ask(args: {
    code: string;
    owner: string;
    albumName?: string;
    ownerName?: string;
  }): Promise<EitherResult<{ ask: AskSummary }>>;
  createFolder(name: string): Promise<EitherResult<{ folder: FolderSummary }>>;
  setActive(folderId: string): Promise<EitherResult<SyncStatus>>;
  setName(name: string): Promise<EitherResult<{ name: string }>>;
  requests(): Promise<{ requests: JoinRequest[] }>;
  /** Admin only: take a member out of the album (their copies stay on their
   * own devices, but the album stops syncing with them). */
  makeMember(folderId: string, memberKey: string): Promise<EitherResult<{ ok: boolean }>>;
  makeViewer(folderId: string, memberKey: string): Promise<EitherResult<{ ok: boolean }>>;
  removeMember(folderId: string, memberKey: string): Promise<EitherResult<{ ok: boolean }>>;
  respond(
    folderId: string,
    requesterKey: string,
    approve: boolean,
    /** "reader" accepts as a Viewer; "member" (the default) as a Collaborator. */
    role?: Role,
  ): Promise<EitherResult<{ ok: boolean }>>;
  /** Admin only: every link sent for the album stops working at once. The album
   * gets a new invite code; answers already given are kept. */
  turnOffInvite(
    folderId: string,
  ): Promise<EitherResult<{ invite: { code: string; owner: string } }>>;
  /** Admin only: remembers when a link just made stops working; asks sent outside every link's time are turned away. */
  saveInviteLink(folderId: string, expiresAt: number): Promise<EitherResult<{ ok: boolean }>>;
  /** Admin only: sends the album's invite straight to a friend's phone, by their key, and waits for the phone to confirm. `role` is what the friend becomes when they tap Join; defaults to Collaborator (`member`). */
  offerAlbum(
    folderId: string,
    identity: string,
    role?: "reader" | "member",
  ): Promise<EitherResult<{ ok: boolean; waiting?: boolean }>>;
  /** Friend only: taps Join on a held invite. Files the ask and tells the Admin's phone, which accepts with no Accept step. */
  joinOffer(code: string, owner: string): Promise<EitherResult<{ ask: AskSummary }>>;
  /** Hides the album on this phone only; it keeps syncing. */
  archiveAlbum(folderId: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Brings an archived album back. */
  restoreAlbum(folderId: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Admin only: removes the album and its photos from every phone. */
  deleteAlbum(folderId: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Member or Viewer: takes the album off this phone. A Member's own drive keeps telling the Admin until the Admin's list drops it. */
  leaveAlbum(folderId: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Clears the "deleted by the Admin" notice of an album. */
  dismissAlbumNotice(folderId: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Joiner: takes a declined ask off this phone; the link can be asked through again. */
  dismissDeclinedAsk(code: string): Promise<EitherResult<{ ok: boolean }>>;
  /** Joiner: takes back a request still waiting; the Admin stops seeing it. The link can be asked through again. */
  cancelAsk(code: string): Promise<EitherResult<{ ok: boolean }>>;
  /** JSON snapshot of live p2p state (connections, topics, drives, folders),
   * served at `/__state` so a field bug can be diagnosed without probes. */
  debugState(): Record<string, unknown>;
  close(): Promise<void>;
}

const DRIVE_PATH_DEVICE = "/device.json";
/** Album name shown until the Admin's `/folder.json` replicates in. */
const JOINED_PLACEHOLDER_NAME = "Joined folder";
const STATE_FILE = "justus.json";

function newId(c: typeof import("bare-crypto")): string {
  return `${Date.now().toString(36)}-${c.randomBytes(4).toString("hex")}`;
}

function hex(buffer: Buffer): string {
  return buffer.toString("hex");
}

/** The swarm topic of a drive. */
function topicOf(drive: Drive): Buffer {
  return Buffer.from(drive.discoveryKey, "hex");
}

/** Decodes standard base64 to bytes. Purpose-built rather than
 * `Buffer.from(s, "base64")` because the bare runtime (ekrooh 0.4.0) rejects
 * otherwise-valid base64 with `Invalid input` at that call site. Portable and
 * dependency-free, so the seed JPEGs boot on every runtime. */
function base64ToBytes(input: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int8Array(128);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (clean[i] === "=") break;
    acc = (acc << 6) | lookup[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

type StreamSource = {
  on(event: "data" | "end" | "error", listener: (...args: any[]) => void): unknown;
};

/** Cap on bytes spooled from a drive to the local cache dir (issue #57). A
 * collaborator's drive can carry an oversized "photo"; capping it bounds
 * device-storage use. Mirrors the upload cap in the upload route. */
const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

/** Pumps a source stream into a file, resolving with the byte count. Pass
 * `maxBytes` to fail (and abort) once the stream exceeds it.
 *
 * Delegates to the bare-agnostic, unit-tested {@link pumpStream} (./pump) so
 * the writer's backpressure signal is honored and `maxBytes` is enforced for
 * every caller. The previous inline copy ignored backpressure and the spool
 * path passed no cap (issues #53 and #57). */
export function pumpToFile(
  source: StreamSource,
  destPath: string,
  maxBytes: number | undefined,
  fs: Files,
): Promise<number> {
  return pumpStream(source, {
    createWriter: () => fs.createWriteStream(destPath) as unknown as PumpWriter,
    maxBytes,
  });
}

/**
 * Per-folder open handles + the derived-gallery machinery that used to be
 * global on the single-folder store. One runtime per folder; a folder stays
 * open (its member drives + swarm topics) even while another folder is active,
 * so switching back costs nothing but a remount.
 */
type FolderRuntime = {
  record: FolderRecord;
  /** The folder's share drive (creator drive): holds members.json, removed.json,
   * folder.json + the creator's own photos. */
  folderDrive: Drive;
  /** The drive THIS device writes photos to inside this folder. For a creator
   * folder this is `folderDrive` itself; for a joined folder it is a drive of
   * its own, made for this album alone (#195), which only takes photos once
   * the Admin has enrolled it. Never the device's identity drive. */
  selfDrive: Drive;
  /** Registered writer drives other than this device, opened read-only. */
  memberDrives: Map<string, Drive>;
  /** For each `memberDrives` entry that is a read-only copy of a Viewer's drive,
   * the version it was opened at. Absent = the live drive. */
  keptAt: Map<string, number>;
  memberNameCache: Map<string, string>;
  /** Viewers the Admin listed in `/viewers.json`; their drives are never opened. */
  viewers: ViewersFile["viewers"];
  /** Set while a check is turning this phone's Viewer into a Collaborator, so an overlapping check still reports it as a role change. */
  upgradingViewer?: boolean;
  /** Loopback routes served for this folder's photos (see `lazyMedia`). */
  mounted: Set<string>;
  /** `remove` closures for this folder's `onDriveChange` watchers, drained
   * on unmount/close so inactive folders stop firing `onChanged` (#46). */
  watcherRemoves: Set<() => void>;
  /** What each phone says it holds, by drive key (this phone's own included). */
  held: Map<string, HeldReport>;
  /** People who left or were removed, from the Admin's `/former.json`. */
  former: FormerPerson[];
  /** True once the photos opened before holding records existed were recorded. */
  heldBackfilled: boolean;
};

export function createPhotoStore(deps: PhotoStoreDeps): PhotoStore {
  const fs = deps.fs;
  const path = deps.path;
  const crypto = deps.crypto;
  // #93/#97: `add(path)` must only import files the picker actually placed in
  // an allowed root (the native picker copies selections into `cacheDir`).
  const importRoots = deps.importRoots ?? [deps.cacheDir];
  /** True when `resolved` is `root` itself or nested under it; avoids prefix
   * false-positives (e.g. `/cache` matching `/cache-evil`). */
  const isWithinRoot = (resolved: string, root: string): boolean => {
    const r = path.resolve(root);
    const p = path.resolve(resolved);
    return p === r || p.startsWith(r + path.sep);
  };
  /**
   * Contain imports so a symlink cannot *escape* an allowed root. The walk
   * starts at the matched root boundary — not at `/` — so a symlinked ancestor
   * of the root (normal on macOS: `/tmp` -> `/private/tmp`, `/var` ->
   * `/private/var`, or any symlinked mount) is never flagged. A symlink *inside*
   * the root is only rejected when following it leaves every allowed root.
   * Uses lstat + readlinkSync (realpathSync is unavailable in bare-fs) so the
   * link is never followed.
   */
  const assertNoSymlink = (resolved: string, root: string, hops = 0): void => {
    // A symlink target is itself walked (below), so a chain a -> b -> /etc or
    // a -> dir/x with dir -> /elsewhere cannot leave the roots one hop at a
    // time. 40 matches the kernel's ELOOP limit.
    if (hops > 40) throw new Error("too many symlinks");
    const rootResolved = path.resolve(root);
    // Walk only the components strictly *inside* the matched root (the root
    // directory itself is not re-checked).
    const tail =
      resolved === rootResolved
        ? ""
        : resolved.startsWith(rootResolved + path.sep)
          ? resolved.slice(rootResolved.length + path.sep.length)
          : resolved;
    const parts = tail.split(path.sep).filter(Boolean);
    let acc: string = rootResolved;
    for (const part of parts) {
      acc = path.join(acc, part);
      let st: ReturnType<typeof fs.lstatSync>;
      try {
        st = fs.lstatSync(acc);
      } catch {
        throw new Error("unresolvable path component");
      }
      if (st.isSymbolicLink()) {
        // Reject only when following the link would leave every allowed root.
        const target = fs.readlinkSync(acc);
        const targetResolved = path.resolve(path.dirname(acc), target);
        const targetRoot = importRoots.find((r) => isWithinRoot(targetResolved, r));
        if (!targetRoot) {
          throw new Error("symlink escapes allowed root");
        }
        assertNoSymlink(targetResolved, targetRoot, hops + 1);
      }
    }
  };
  const lazyMedia = createLazyMedia(deps.server, fs);
  const network = deps.network;
  const stateFile = path.join(deps.storageDir, STATE_FILE);

  /** The saved state was written by a newer Justus: touch nothing. */
  let tooNew = false;
  /** The saved state still has the version 1 shape (see `migrateFromV1`). */
  let migrating = false;
  let state: PersistedState = loadState();
  /** The device's identity drive: `/device.json` and the join-request outbox.
   * It holds no photos: every album has a drive of its own, so a photo only
   * ever reaches the people in the album it was added to (#195). (Installs from
   * before #195 may still use it as the "My Photos" album drive.) */
  let ownDrive: Drive;
  const runtimes = new Map<string, FolderRuntime>();
  /** Requester keys the creator denied this session. Denials write no durable
   * state (the request only lives on the requester's own drive), so a denied
   * requester would otherwise re-surface in `requests()` every time it re-files
   * a join request (issue #85). We remember denials in-memory for the session. */
  const deniedRequesters = new Set<string>();
  /** Identity drive keys of peers we have connected to this session, as they
   * told us over the identity channel. An Admin reads join requests off these
   * drives' `/requests.json` outboxes. */
  const peerIdentities = new Set<string>();
  /** Each peer's identity drive, opened once and kept: Hyperdrive takes its
   * core exclusively, so a second open of the same key waits for the first to
   * close. Watched so a request that replicates in refreshes the inbox. */
  const peerOutboxes = new Map<string, Promise<Drive>>();
  /** Timers of answer deliveries waiting to retry. */
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const log = createP2pLog(deps.log);
  const joinPorts: JoinPorts = {
    drives: deps.drives,
    network,
    log,
    openTimeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
  };
  /** A phone on a newer Justus refused us; for this session only. */
  let updateNeeded = false;
  /** Names of phones on an older Justus we refused; for this session only. */
  const peersBehind: string[] = [];
  const MAX_PEERS_BEHIND = 5;
  const conns = new Map<
    number,
    {
      noiseKey?: string;
      identityKey?: string;
      openedAt: number;
      initiator?: boolean;
      /** The identity above is proven: its `/device.json` names this connection's noise key. */
      verified?: boolean;
      /** Peer protocol the remote announced; unset until it does. */
      protocol?: number;
      /** The remote speaks another protocol: nothing but its name is read. */
      refused?: "newer" | "older";
      noted?: boolean;
      /** `code` of each answer already sent on this connection. */
      sent: Set<string>;
    }
  >();
  /** Self drives opened by namespace; Hyperdrive takes its core exclusively,
   * so a second open of the same namespace would wait on the first. */
  const selfDrives = new Map<string, Promise<Drive>>();
  /** Which identity drive each request in a peer's outbox came from, and which
   * of them were made through an invite code. */
  const requesterIdentity = new Map<string, string>();
  const inviteRequesters = new Set<string>();
  const askInflight = new Map<string, Promise<unknown>>();
  const completing = new Set<string>();
  /** Resolved peer-outbox drives (the map above holds promises). */
  const peerOutboxDrives = new Map<string, Drive>();
  /** Viewers' drives, opened only to read `/device.json` (who is connected),
   * keyed by drive key. Never part of a folder's member drives. */
  const viewerDevices = new Map<string, Promise<unknown>>();
  const viewerDeviceDrives = new Map<string, { drive: Drive; off: () => void }>();
  let closed = false;
  let readyPromise: Promise<void> | null = null;

  /**
   * Content index (issue #43): sha256 → the photos carrying those bytes, so
   * `add`'s content dedupe no longer re-scans every drive (which silently skips
   * unreachable peers and let a re-add of our own bytes slip through). Seeded
   * best-effort from the drives we can see and kept current on add/remove; it is
   * never evicted when a drive is merely unreachable, so a momentary outage
   * can't defeat the dedupe.
   */
  type IndexedPhoto = {
    id: string;
    driveKey: string;
    /** The folder this photo belongs to. Dedupe is scoped per folder (issue
     * #156): a re-add of identical bytes to a *different* folder must write
     * them there, never return a prior folder's spool entry. */
    folderId: string;
    name: string;
    mime: string;
    size: number;
    addedAt: number;
    sha256: string;
    /** Extension (incl. leading dot) — needed to re-derive the spool name when
     * a re-add of the same bytes is served from the content index (issues
     * #81/#83/#87). */
    ext: string;
    hasThumb?: true;
  };
  const contentIndex = new Map<string, IndexedPhoto[]>();

  function loadState(): PersistedState {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      if (isTextJSON(parsed)) {
        const version = stateVersionOf(parsed);
        if (version > STATE_VERSION) tooNew = true;
        // A file without `version` predates the key move; it is saved as
        // version 2 only once every album of ours has moved.
        if (version < STATE_VERSION) migrating = true;
        const name = typeof parsed.name === "string" ? parsed.name : deps.deviceName;
        const activeFolderId =
          typeof parsed.activeFolderId === "string" ? parsed.activeFolderId : null;
        const rawFolders = Array.isArray(parsed.folders) ? (parsed.folders as unknown[]) : [];
        const folders: FolderRecord[] = [];
        for (const f of rawFolders) {
          if (
            isTextJSON(f) &&
            typeof f.id === "string" &&
            typeof f.name === "string" &&
            typeof f.shareKey === "string" &&
            typeof f.driveKey === "string"
          ) {
            folders.push({
              id: f.id,
              name: f.name,
              role: (typeof f.role === "string" ? f.role : "reader") as Role,
              // Carry the pending (awaiting-approval) flag so a requested join
              // keeps its badge after a restart (#94). `saveState` already
              // serializes it; only loadState was dropping it.
              pending: typeof f.pending === "boolean" ? f.pending : false,
              shareKey: f.shareKey,
              driveKey: f.driveKey,
              createdAt: typeof f.createdAt === "number" ? f.createdAt : 0,
              ...loadFolderExtras(f),
            });
          }
        }
        return {
          name,
          folders,
          activeFolderId,
          asks: loadAsks(parsed.asks),
          offers: loadOffers(parsed.offers),
          gone: loadGone(parsed.gone),
        };
      }
    } catch {
      // Fresh state.
    }
    return {
      name: deps.deviceName,
      folders: [],
      activeFolderId: null,
      asks: [],
      offers: [],
      gone: [],
    };
  }

  function loadFolderExtras(f: { [k: string]: unknown }): Partial<FolderRecord> {
    const out: Partial<FolderRecord> = {};
    const inv = f.invite;
    if (isTextJSON(inv) && typeof inv.code === "string" && isHexKey(inv.code)) {
      const links = Array.isArray(inv.links)
        ? (inv.links as unknown[])
            .flatMap((l): LinkTime[] =>
              isTextJSON(l) &&
              typeof l.from === "number" &&
              typeof l.to === "number" &&
              Number.isFinite(l.from) &&
              Number.isFinite(l.to) &&
              l.from <= l.to
                ? [{ from: l.from, to: l.to }]
                : [],
            )
            .slice(-MAX_LINK_TIMES)
        : undefined;
      out.invite = {
        code: inv.code,
        ...(typeof inv.owner === "string" && isHexKey(inv.owner) ? { owner: inv.owner } : {}),
        ...(links?.length ? { links } : {}),
      };
    }
    if (isTextJSON(f.answers)) {
      const answers: Answers = {};
      for (const [id, a] of Object.entries(f.answers)) {
        if (isHexKey(id) && (a === "accepted" || a === "declined")) answers[id] = a;
      }
      out.answers = answers;
    }
    if (isTextJSON(f.declinedAsks)) {
      const declinedAsks: Record<string, number> = {};
      for (const [id, t] of Object.entries(f.declinedAsks)) {
        if (isHexKey(id) && typeof t === "number" && Number.isFinite(t)) declinedAsks[id] = t;
      }
      out.declinedAsks = declinedAsks;
    }
    if (isTextJSON(f.heldAsks)) {
      const heldAsks: Record<string, string> = {};
      for (const [id, code] of Object.entries(f.heldAsks)) {
        if (isHexKey(id) && typeof code === "string" && isHexKey(code)) heldAsks[id] = code;
      }
      if (Object.keys(heldAsks).length > 0) out.heldAsks = heldAsks;
    }
    if (Array.isArray(f.retiredInvites)) {
      out.retiredInvites = (f.retiredInvites as unknown[]).filter(
        (c): c is string => typeof c === "string" && isHexKey(c),
      );
    }
    if (Array.isArray(f.invited)) {
      out.invited = (f.invited as unknown[]).filter(
        (c): c is string => typeof c === "string" && isHexKey(c),
      );
    }
    if (isTextJSON(f.offerOwed)) {
      const owed: OwedOffers = {};
      for (const [id, t] of Object.entries(f.offerOwed)) {
        if (isHexKey(id) && typeof t === "number" && Number.isFinite(t)) owed[id] = t;
      }
      if (Object.keys(owed).length > 0) out.offerOwed = owed;
    }
    if (isTextJSON(f.invitedRoles)) {
      const roles: Record<string, "reader" | "member"> = {};
      for (const [id, r] of Object.entries(f.invitedRoles)) {
        if (isHexKey(id) && (r === "reader" || r === "member")) roles[id] = r;
      }
      if (Object.keys(roles).length > 0) out.invitedRoles = roles;
    }
    if (typeof f.selfNs === "string" && f.selfNs) out.selfNs = f.selfNs;
    if (typeof f.rotatedAt === "number") out.rotatedAt = f.rotatedAt;
    if (Array.isArray(f.earlier)) {
      const earlier: EarlierEntry[] = [];
      for (const e of f.earlier as unknown[]) {
        if (isTextJSON(e) && typeof e.key === "string" && isHexKey(e.key)) {
          earlier.push({
            key: e.key,
            name: peerName(e.name, "Unknown device"),
            ...(typeof e.keptVersion === "number" &&
            Number.isInteger(e.keptVersion) &&
            e.keptVersion >= 0
              ? { keptVersion: e.keptVersion }
              : {}),
          });
        }
      }
      out.earlier = earlier;
    }
    if (Array.isArray(f.pastKeys)) {
      out.pastKeys = (f.pastKeys as unknown[])
        .filter((k): k is string => typeof k === "string" && isHexKey(k))
        .slice(0, MAX_PAST_KEYS);
    }
    if (typeof f.moves === "number" && Number.isInteger(f.moves) && f.moves > 0) {
      out.moves = f.moves;
    }
    if (isTextJSON(f.moving)) {
      const moving: Record<string, MovingEntry> = {};
      for (const [identity, m] of Object.entries(f.moving)) {
        if (!isHexKey(identity) || !isTextJSON(m)) continue;
        if ((m.role !== "member" && m.role !== "reader") || typeof m.key !== "string") continue;
        if (!isHexKey(m.key)) continue;
        moving[identity] = { role: m.role, name: peerName(m.name, "Unknown device"), key: m.key };
      }
      if (Object.keys(moving).length > 0) out.moving = moving;
    }
    if (isTextJSON(f.movingUnknown)) {
      const unknown: Record<string, MovingEntry> = {};
      for (const [key, m] of Object.entries(f.movingUnknown)) {
        if (!isHexKey(key) || !isTextJSON(m)) continue;
        if ((m.role !== "member" && m.role !== "reader") || m.key !== key) continue;
        unknown[key] = { role: m.role, name: peerName(m.name, "Unknown device"), key };
      }
      if (Object.keys(unknown).length > 0) out.movingUnknown = unknown;
    }
    if (Array.isArray(f.moveOwed)) {
      const owed = (f.moveOwed as unknown[]).filter(
        (k): k is string => typeof k === "string" && isHexKey(k),
      );
      if (owed.length > 0) out.moveOwed = owed;
    }
    if (isTextJSON(f.keptUntil)) {
      const kept: Record<string, number> = {};
      for (const [key, version] of Object.entries(f.keptUntil)) {
        if (Object.keys(kept).length >= MAX_KEPT_DRIVES) break;
        if (!isHexKey(key) || typeof version !== "number") continue;
        if (!Number.isInteger(version) || version < 0) continue;
        kept[key] = version;
      }
      out.keptUntil = kept;
    }
    if (f.moved === true) out.moved = true;
    if (f.lifecycle === "archived" || f.lifecycle === "leaving" || f.lifecycle === "deleting") {
      out.lifecycle = f.lifecycle;
    }
    if (isTextJSON(f.notice)) {
      if (f.notice.kind === "newKey") out.notice = { kind: "newKey" };
      else if (f.notice.kind === "removed") out.notice = { kind: "removed" };
      else if (f.notice.kind === "moved") {
        out.notice = { kind: "moved", ownerName: peerName(f.notice.ownerName, DEFAULT_ASK_OWNER) };
      }
    }
    return out;
  }

  function loadGone(raw: unknown): GoneRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: GoneRecord[] = [];
    for (const g of raw as unknown[]) {
      if (!isTextJSON(g)) continue;
      if (typeof g.id !== "string" || typeof g.shareKey !== "string") continue;
      if (
        g.kind !== "deletedForEveryone" &&
        g.kind !== "deletedByAdmin" &&
        g.kind !== "waitingForAdminToSeeYouLeft"
      ) {
        continue;
      }
      out.push({
        id: g.id,
        name: peerName(g.name, DEFAULT_ASK_ALBUM),
        shareKey: g.shareKey,
        kind: g.kind,
        ...(typeof g.selfNs === "string" ? { selfNs: g.selfNs } : {}),
        ...(g.listedIn === "viewers" ? { listedIn: "viewers" as const } : {}),
        ...(typeof g.adminName === "string"
          ? { adminName: peerName(g.adminName, DEFAULT_ASK_OWNER) }
          : {}),
        at: typeof g.at === "number" ? g.at : 0,
      });
    }
    return out;
  }

  function loadOffers(raw: unknown): OfferSummary[] {
    if (!Array.isArray(raw)) return [];
    let out: OfferSummary[] = [];
    for (const o of raw as unknown[]) {
      if (!isTextJSON(o)) continue;
      if (typeof o.code !== "string" || !isHexKey(o.code)) continue;
      if (typeof o.owner !== "string" || !isHexKey(o.owner)) continue;
      out = holdOffer(out, {
        code: o.code,
        owner: o.owner,
        albumName: peerName(o.albumName, DEFAULT_ASK_ALBUM),
        ownerName: peerName(o.ownerName, DEFAULT_ASK_OWNER),
      });
    }
    return out;
  }

  function loadAsks(raw: unknown): AskRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: AskRecord[] = [];
    for (const a of raw as unknown[]) {
      if (!isTextJSON(a)) continue;
      if (typeof a.code !== "string" || !isHexKey(a.code)) continue;
      if (typeof a.owner !== "string" || !isHexKey(a.owner)) continue;
      if (
        a.status !== "waiting" &&
        a.status !== "declined" &&
        a.status !== "accepted" &&
        a.status !== "linkOff"
      )
        continue;
      out.push({
        code: a.code,
        owner: a.owner,
        albumName: peerName(a.albumName, DEFAULT_ASK_ALBUM),
        ownerName: peerName(a.ownerName, DEFAULT_ASK_OWNER),
        askedAt: typeof a.askedAt === "number" ? a.askedAt : 0,
        status: a.status,
        ...(typeof a.shareKey === "string" && isHexKey(a.shareKey) ? { shareKey: a.shareKey } : {}),
        ...(typeof a.replaces === "string" ? { replaces: a.replaces } : {}),
      });
    }
    return out;
  }

  function saveState() {
    if (tooNew) return;
    try {
      const file = migrating ? state : { version: STATE_VERSION, ...state };
      fs.writeFileSync(stateFile, JSON.stringify(file));
    } catch (e) {
      const message = errMsg(e);
      console.error(`[justus] failed to persist state: ${message}`);
    }
  }

  /** Reads a small text record, or null when missing, unreadable, or larger
   * than the peer-record cap. */
  async function readText(
    drive: Drive,
    drivePath: string,
    opts?: { timeout: number },
  ): Promise<string | null> {
    return readRecord(drive, { path: drivePath, log, timeoutMs: opts?.timeout });
  }

  // --- Presence: which members this device can reach right now. -----------
  const PRESENCE_FILE = path.join(deps.storageDir, "presence.json");
  const presence = createPresence({ lastSeen: readLastSeenFile() });

  function readLastSeenFile(): [string, number][] {
    try {
      return parseLastSeen(fs.readFileSync(PRESENCE_FILE, "utf8"));
    } catch {
      return [];
    }
  }

  function saveLastSeen() {
    try {
      fs.writeFileSync(PRESENCE_FILE, serializeLastSeen(presence));
    } catch (e) {
      console.error(`[justus] failed to persist presence: ${errMsg(e)}`);
    }
  }

  /** Tell the web layer presence changed; it refreshes status only. */
  function announcePresence() {
    const rt = activeRuntime();
    if (rt) deps.onChanged({ cause: "presence", folderId: rt.record.id });
  }

  /** Learn peer keys for every member of every folder we hold. */
  async function resolveSwarmKeys(): Promise<boolean> {
    let learned = false;
    for (const rt of runtimes.values()) {
      const sources: DeviceSource[] = [...rt.memberDrives].map(([memberKey, drive]) => ({
        memberKey,
        drive,
      }));
      if (rt.record.role !== "creator")
        sources.push({ memberKey: rt.record.shareKey, drive: rt.folderDrive });
      for (const key of Object.keys(rt.viewers)) {
        if (key === selfKeyOf(rt) || key === rt.record.shareKey) continue;
        if (rt.memberDrives.has(key) && !rt.keptAt.has(key)) continue;
        const open = viewerDeviceDrives.get(key);
        if (open) sources.push({ memberKey: key, drive: open.drive });
        else openViewerDevice(key);
      }
      for (const entry of Object.values(rt.record.movingUnknown ?? {})) {
        if (entry.role !== "reader" || rt.memberDrives.has(entry.key)) continue;
        const open = viewerDeviceDrives.get(entry.key);
        if (open) sources.push({ memberKey: entry.key, drive: open.drive });
        else openViewerDevice(entry.key);
      }
      learned =
        (await learnDevices(presence, {
          sources,
          timeoutMs: 1500,
          log,
          verify: (p) => deps.drives.verifyIdentity(p),
        })) || learned;
    }
    for (const identity of claimUnknownMoving()) {
      void deliverMoveOffers(identity).catch(answerErr("moveOffer"));
    }
    await releaseViewerDevices();
    return learned;
  }

  /** Drops Viewer drives of people who are no longer a Viewer anywhere. */
  async function releaseViewerDevices() {
    const wanted = new Set<string>();
    for (const rt of runtimes.values()) {
      for (const key of Object.keys(rt.viewers)) wanted.add(key);
      for (const entry of Object.values(rt.record.movingUnknown ?? {})) wanted.add(entry.key);
    }
    for (const [key, { drive, off }] of [...viewerDeviceDrives]) {
      if (wanted.has(key)) continue;
      viewerDeviceDrives.delete(key);
      viewerDevices.delete(key);
      off();
      await deps.drives.release(drive).catch(() => {});
    }
  }

  /** Re-learn members' swarm keys and announce if any changed. Runs on every
   * connection and every drive change: a member approved after we connected,
   * or one that restarted with a new swarm key, only becomes known once its
   * `/device.json` replicates in. */
  function refreshPresence() {
    void resolveSwarmKeys()
      .then((learned) => learned && announcePresence())
      .catch((e) => console.error(`[justus] presence refresh failed: ${errMsg(e)}`));
  }

  function onPeerEvent(e: PeerEvent) {
    if (e.type === "connected") {
      conns.set(e.conn, {
        noiseKey: e.peerKey,
        openedAt: Date.now(),
        initiator: e.initiator,
        sent: new Set(),
      });
      onPeerUp(e.peerKey);
    } else if (e.type === "version") {
      onPeerVersion(e.conn, e.protocol);
    } else if (e.type === "identified") {
      onPeerIdentity(e.identityKey, e.conn);
    } else if (e.type === "answer") {
      if (isFriendMessageShape(e.value)) {
        void onFriendMessage(e.conn, e.value).catch(answerErr("friend"));
      } else {
        void onAnswerMessage(e.conn, e.value).catch(answerErr("answer"));
      }
    } else {
      conns.delete(e.conn);
      onPeerDown(e.peerKey);
    }
  }

  function onPeerUp(peerKey: string) {
    peerConnected(presence, { peerKey, log });
    announcePresence();
    refreshPresence();
  }

  function onPeerDown(peerKey: string) {
    const down = peerDisconnected(presence, { peerKey, now: Date.now(), log });
    if (down === "still-connected") return;
    if (down === "member-down") saveLastSeen();
    announcePresence();
  }

  async function readDeviceName(drive: Drive): Promise<string> {
    return parseDeviceName(await readText(drive, DRIVE_PATH_DEVICE));
  }

  /** The Admin's name as their phone publishes it, or undefined when unknown. */
  async function adminNameOf(rt: FolderRuntime): Promise<string | undefined> {
    try {
      const name = await withTimeout(readDeviceName(rt.folderDrive), 2_000);
      return name === undefined || name === "Unknown device" ? undefined : name;
    } catch {
      return undefined;
    }
  }

  /** Tells the screen this phone's role changed. */
  function roleChangePush(
    rt: FolderRuntime,
    from: "member" | "reader",
    to: "member" | "reader",
    adminName: string | undefined,
  ) {
    log("role.changed", { folder: short(rt.record.id), from, to });
    deps.onChanged({
      cause: "role",
      folderId: rt.record.id,
      role: { from, to, albumName: rt.record.name, ...(adminName ? { adminName } : {}) },
    });
  }

  /** The swarm's noise public key. Swarm connections identify a peer by this
   * key, not by its drive key, so each device publishes it in `/device.json`
   * and peers use it to tell which member a connection belongs to. */
  function ownSwarmKey(): string | undefined {
    return network.peerKey() || undefined;
  }

  /** The record this phone writes into a drive. With `driveKey`, it carries this
   * phone's identity signature for that drive. Without, it is unsigned. */
  async function deviceJson(name: string, driveKey?: string): Promise<Buffer> {
    const base = { name, swarmKey: ownSwarmKey(), identityKey: ownDrive.key };
    if (driveKey === undefined) return Buffer.from(JSON.stringify(base));
    const [signErr, signed] = await deps.drives.signAsIdentity(identityMessage(driveKey));
    if (signErr) return Buffer.from(JSON.stringify(base));
    return Buffer.from(
      JSON.stringify({
        ...base,
        identityPublicKey: signed.publicKey,
        identitySig: signed.signature,
      }),
    );
  }

  async function ensureOwnDriveIdentity() {
    const text = await readText(ownDrive, DRIVE_PATH_DEVICE);
    // The swarm key is random per boot, so rewrite whenever it differs.
    if (text === null || !text.includes(`"swarmKey":"${ownSwarmKey()}"`)) {
      await ownDrive.put(DRIVE_PATH_DEVICE, await deviceJson(state.name));
    }
  }

  function watchDrive(drive: Drive, folderId: string, label: string, cause: PhotoChangedCause) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      log("drive.change", {
        drive: short(drive.key),
        length: drive.stats().length,
        folder: short(folderId),
      });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rt = runtimes.get(folderId);
        // A member whose join was approved since we last ran is now a member —
        // re-read the registry and upgrade reader → member in-session (issue
        // #52) instead of waiting for a restart.
        if (rt && rt.record.role === "reader") {
          // Best-effort background upgrade; never block the watcher. Guard the
          // promise so a rejection (e.g. registry read failing) can't become an
          // unhandled rejection that crashes the process.
          void upgradePendingRole(rt).catch((e) =>
            log("error", { where: "upgradePendingRole", folder: short(folderId), err: errText(e) }),
          );
        }
        // The Admin's drive changed (or first replicated in after we joined
        // with only the invite's name): take the album name from it.
        if (rt && drive === rt.folderDrive) {
          void refreshFormer(rt).catch((e) =>
            log("error", { where: "refreshFormer", err: errText(e) }),
          );
          void refreshViewers(rt)
            .then(async (viewersChanged) => {
              const changed = viewersChanged || (await refreshEarlier(rt));
              if (!changed) return;
              if (rt.record.role !== "creator") {
                await becomeViewerIfListed(rt);
                await refreshMembersFor(rt);
                armFolderWatchers(rt);
              }
              deps.onChanged({ cause: "enroll", folderId });
            })
            .catch((e) =>
              log("error", { where: "refreshViewers", folder: short(folderId), err: errText(e) }),
            );
          void refreshAlbumName(rt).catch((e) =>
            log("error", { where: "refreshAlbumName", folder: short(folderId), err: errText(e) }),
          );
        }
        // The Admin's drive may now carry the delete note.
        if (rt && drive === rt.folderDrive && rt.record.role !== "creator") {
          void checkDeleteNote(rt, 2_000).catch((e) =>
            log("error", { where: "checkDeleteNote", folder: short(folderId), err: errText(e) }),
          );
        }
        // The Admin's drive may now say this phone was removed.
        if (rt && drive === rt.folderDrive && rt.record.role !== "creator") {
          void checkRemovedNote(rt, 2_000).catch((e) =>
            log("error", { where: "checkRemovedNote", folder: short(folderId), err: errText(e) }),
          );
        }
        // A member's drive may now carry the note that they left.
        if (rt && rt.record.role === "creator" && rt.memberDrives.get(label) === drive) {
          void dropMemberWhoLeft(rt, label).catch((e) =>
            log("error", { where: "dropMemberWhoLeft", folder: short(folderId), err: errText(e) }),
          );
        }
        // A Collaborator's new drive may now hold what their old one did.
        if (rt && rt.record.role === "creator" && (rt.record.earlier ?? []).length > 0) {
          void dropCaughtUpEarlier(rt)
            .then(async (dropped) => {
              if (dropped) await refreshMembersFor(rt);
            })
            .catch((e) =>
              log("error", {
                where: "dropCaughtUpEarlier",
                folder: short(folderId),
                err: errText(e),
              }),
            );
        }
        if (rt && drive !== rt.selfDrive) {
          void refreshHeld(rt, drive.key, drive).catch((e) =>
            log("error", { where: "refreshHeld", err: errText(e) }),
          );
        }
        refreshPresence();
        // Drive metadata changed locally or via replication — the gallery is
        // derived, so a refresh always suffices.
        deps.onChanged({ cause, folderId, memberKey: label });
      }, 400);
    };
    const off = drive.onChange(handler);
    const remove = () => {
      off();
      if (timer) clearTimeout(timer);
    };
    const rt = runtimes.get(folderId);
    rt?.watcherRemoves.add(remove);
  }

  function armFolderWatchers(rt: FolderRuntime) {
    void startHolding(rt).catch((e) => log("error", { where: "startHolding", err: errText(e) }));
    for (const remove of rt.watcherRemoves) {
      try {
        remove();
      } catch {
        // already removed
      }
    }
    rt.watcherRemoves.clear();
    watchDrive(
      rt.folderDrive,
      rt.record.id,
      rt.folderDrive.key,
      rt.record.role === "creator" ? "enroll" : "add",
    );
    // A creator's own drive *is* the folder drive; watching it twice would
    // push every change twice.
    if (rt.selfDrive && rt.selfDrive !== rt.folderDrive) {
      watchDrive(rt.selfDrive, rt.record.id, rt.selfDrive.key, "enroll");
    }
    for (const [key, drive] of rt.memberDrives) {
      if (rt.keptAt.has(key)) continue;
      watchDrive(drive, rt.record.id, key, "add");
    }
  }

  /** Joins a topic; serves it unless told otherwise. */
  function joinTopic(topic: Buffer, opts?: { server?: boolean }) {
    network.join(hex(topic), { server: opts?.server !== false });
  }

  function leaveTopic(keyHex: string) {
    network.leave(keyHex);
  }

  /** Re-runs the topic lookup until the drive has a peer. */
  function rediscover(topic: Buffer, drive: Drive) {
    network.findPeers(hex(topic), () => drive.stats().peers > 0, {
      drive: drive.key,
      peers: () => drive.stats().peers,
    });
  }

  /** Opens a drive by key, joining its swarm topic first so peers serve its
   * blocks (a remote `drive.ready()` otherwise waits forever). */
  async function openDriveWithTopic(keyHex: string, opts?: { server?: boolean }): Promise<Drive> {
    const [openErr, drive] = await openWithTopic(joinPorts, {
      key: keyHex,
      server: opts?.server !== false,
    });
    if (openErr) throw openErr;
    return drive;
  }

  async function readRegistryIn(drive: Drive): Promise<RegistryFile> {
    return readRegistry(drive, { log });
  }

  async function readRemovedIn(drive: Drive): Promise<RemovedFile["removed"]> {
    return parseRemoved(await readText(drive, DRIVE_PATH_REMOVED));
  }

  /** An album we joined is named by its Admin's `/folder.json`; until that
   * replicates in we show the invite's name (or a placeholder). */
  function nameErr(rt: FolderRuntime) {
    return (e: unknown) =>
      log("error", { where: "refreshAlbumName", folder: short(rt.record.id), err: errText(e) });
  }

  async function refreshAlbumName(rt: FolderRuntime) {
    if (rt.record.role === "creator") return;
    const name = await albumNameUpdate(rt.folderDrive, {
      role: rt.record.role,
      current: rt.record.name,
      log,
    });
    if (name === undefined) return;
    rt.record.name = name;
    const persisted = state.folders.find((f) => f.id === rt.record.id);
    if (persisted) persisted.name = name;
    saveState();
    deps.onChanged({ cause: "add", folderId: rt.record.id });
  }

  /** The albums shown on this phone: every saved album but the archived ones. */
  function shownFolders(): FolderRecord[] {
    return state.folders.filter((f) => f.lifecycle !== "archived");
  }

  function activeFolderId(): string | null {
    const shown = shownFolders();
    if (state.activeFolderId && shown.some((f) => f.id === state.activeFolderId)) {
      return state.activeFolderId;
    }
    return shown.length > 0 ? shown[0].id : null;
  }

  function activeRuntime(): FolderRuntime | null {
    const id = activeFolderId();
    return id ? (runtimes.get(id) ?? null) : null;
  }

  /** The named album's runtime, or the active one when no id is given. */
  function runtimeFor(folderId?: string): FolderRuntime | null {
    return folderId ? (runtimes.get(folderId) ?? null) : activeRuntime();
  }

  /** Spool dir for a folder (per-folder so switching active never serves stale
   * bytes from another folder). */
  function spoolDirFor(folderId: string): string {
    return path.join(deps.cacheDir, "photos", folderId);
  }

  /** Base file names under the photos dir of a drive (sans the dir prefix);
   * empty when the drive isn't downloaded yet. */
  async function drivePhotoKeys(drive: Drive): Promise<string[]> {
    const keys: string[] = [];
    try {
      const list = drive.list(DRIVE_PATH_PHOTOS);
      for await (const entry of list) {
        keys.push(entry.path.slice(DRIVE_PATH_PHOTOS.length + 1));
      }
    } catch {
      // Drive not downloaded yet — empty.
    }
    return keys;
  }

  /** Key of the drive this device writes to in `rt` (see `selfDrive`). */
  function selfKeyOf(rt: FolderRuntime): string {
    return rt.selfDrive.key;
  }

  /** This device's drive inside the album with `shareKey` (#195). One per
   * album, on its own namespace, so the same share key always reopens the
   * same drive and a photo added here never shows up in another album. It is
   * served on its own topic so the Admin and members can open it by key. */
  function openSelfDrive(shareKey: string, selfNs?: string): Promise<Drive> {
    return openSelfDriveIn(selfNs ?? `member/${shareKey}`);
  }

  function openSelfDriveIn(ns: string): Promise<Drive> {
    let opening = selfDrives.get(ns);
    if (!opening) {
      opening = (async () => {
        const drive = await deps.drives.openOwn(ns);
        // Presence reads the swarm key from here, and it changes every boot.
        await drive.put(DRIVE_PATH_DEVICE, await deviceJson(state.name, drive.key));
        joinTopic(topicOf(drive));
        rediscover(topicOf(drive), drive);
        return drive;
      })();
      opening.catch(() => selfDrives.delete(ns));
      selfDrives.set(ns, opening);
    }
    return opening;
  }

  async function loadMemberDrive(rt: FolderRuntime, keyHex: string, name?: string) {
    if (rt.memberDrives.has(keyHex)) return;
    if (keyHex === selfKeyOf(rt)) return;
    try {
      const drive = await openDriveWithTopic(keyHex, { server: false });
      rt.memberDrives.set(keyHex, drive);
      if (name) rt.memberNameCache.set(keyHex, name);
      watchDrive(drive, rt.record.id, keyHex, "add");
    } catch (e) {
      const message = errMsg(e);
      console.error(`[justus] failed to open member drive ${keyHex.slice(0, 12)}: ${message}`);
    }
  }

  /** Opens a Viewer's drive as it was at `version`, so what they added after
   * they became a Viewer is never read. A copy never changes: no watcher. */
  async function openKeptDrive(rt: FolderRuntime, keyHex: string, version: number, name: string) {
    network.join(deps.drives.discoveryKeyOf(keyHex), { server: false });
    const [openErr, drive] = await deps.drives.openAt(keyHex, version, { timeoutMs: 10_000 });
    if (openErr) {
      log("error", {
        where: "openKeptDrive",
        drive: short(keyHex),
        version,
        err: errText(openErr),
      });
      return;
    }
    rt.memberDrives.set(keyHex, drive);
    rt.keptAt.set(keyHex, version);
    rt.memberNameCache.set(keyHex, name);
  }

  /** On a Collaborator's phone: the Admin has moved this phone's person to the
   * Viewers, so the phone reads like a Viewer's from now on. */
  async function becomeViewerIfListed(rt: FolderRuntime) {
    const listed = () => rt.record.role === "member" && rt.viewers[selfKeyOf(rt)] !== undefined;
    if (!listed()) return;
    const adminName = await adminNameOf(rt);
    if (!listed()) return;
    rt.record.role = "reader";
    rt.record.driveKey = "";
    rt.record.pending = false;
    saveState();
    roleChangePush(rt, "member", "reader", adminName);
  }

  /** Re-reads the Admin's Viewer list. True when it changed. */
  async function refreshViewers(rt: FolderRuntime): Promise<boolean> {
    const file = await readViewers(rt.folderDrive, { log });
    const same =
      JSON.stringify(Object.entries(file.viewers).sort()) ===
      JSON.stringify(Object.entries(rt.viewers).sort());
    rt.viewers = file.viewers;
    return !same;
  }

  const droppingMembers = new Set<string>();

  /** Admin: a member whose drive says they left (after they were added) is taken off the people list, and their old link starts a fresh ask. */
  async function dropMemberWhoLeft(rt: FolderRuntime, memberKey: string): Promise<void> {
    const drive = rt.memberDrives.get(memberKey);
    const busyKey = `${rt.record.id}/${memberKey}`;
    if (!drive || droppingMembers.has(busyKey)) return;
    droppingMembers.add(busyKey);
    try {
      const addedAt = (await readRegistryIn(rt.folderDrive)).members[memberKey]?.addedAt;
      if (addedAt === undefined) return;
      const note = await readLeftNote(drive, { log, timeoutMs: 2_000 });
      if (!note || note.leftAt <= addedAt) return;
      const device = verifiedDeviceIdentity((await readText(drive, DRIVE_PATH_DEVICE)) ?? "", {
        driveKey: drive.key,
        verify: (p) => deps.drives.verifyIdentity(p),
      });
      await noteFormer(
        rt,
        markLeft(await formerSnapshot(rt, memberKey)),
        device.status === "verified" ? device.identityKey : undefined,
      );
      const [removeErr] = await removeAlbumMember(rt.folderDrive, { memberKey, log });
      if (removeErr) {
        log("error", { where: "dropMemberWhoLeft", err: removeErr.message });
        return;
      }
      if (device.status === "verified") setAnswer(rt, device.identityKey, undefined);
      await refreshMembersFor(rt);
      deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey });
    } finally {
      droppingMembers.delete(busyKey);
    }
  }

  /** Admin: a Viewer whose own drive says they left (after they were listed) is taken off the Viewers list. */
  async function dropViewerWhoLeft(
    rt: FolderRuntime,
    viewerKey: string,
    drive: Drive,
  ): Promise<void> {
    const busyKey = `${rt.record.id}/${viewerKey}`;
    if (rt.record.role !== "creator" || droppingMembers.has(busyKey)) return;
    droppingMembers.add(busyKey);
    try {
      const file = await readViewers(rt.folderDrive, { log });
      const entry = file.viewers[viewerKey];
      if (!entry) return;
      const note = await readLeftNote(drive, { log, timeoutMs: 2_000 });
      if (!note || note.leftAt <= entry.addedAt) return;
      const identity = await identityOfDrive(drive);
      const snapshot = await formerSnapshot(rt, viewerKey);
      // Re-read right before the write: a Viewer seated during the awaits above
      // must not be overwritten by the stale copy.
      const fresh = await readViewers(rt.folderDrive, { log });
      const [removeErr, next] = await removeViewer(rt.folderDrive, {
        viewers: fresh,
        viewerKey,
      });
      if (removeErr) {
        log("error", { where: "dropViewerWhoLeft", err: removeErr.message });
        return;
      }
      await noteFormer(rt, markLeft(snapshot), identity);
      rt.viewers = next.viewers;
      if (identity !== undefined) setAnswer(rt, identity, undefined);
      await refreshMembersFor(rt);
      deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey: viewerKey });
    } finally {
      droppingMembers.delete(busyKey);
    }
  }

  function dropViewersWhoLeft(keyHex: string, drive: Drive) {
    for (const rt of runtimes.values()) {
      if (rt.record.role !== "creator" || !rt.viewers[keyHex]) continue;
      void dropViewerWhoLeft(rt, keyHex, drive).catch((e) =>
        log("error", { where: "dropViewerWhoLeft", err: errText(e) }),
      );
    }
  }

  /** On a phone that is not the Admin's: reads the Admin's list of earlier
   * drives. True when it changed. */
  async function refreshEarlier(rt: FolderRuntime): Promise<boolean> {
    if (rt.record.role === "creator") return false;
    const text = await readText(rt.folderDrive, DRIVE_PATH_EARLIER);
    const earlier = parseEarlier(text, () => log("earlier.unsupported", {}));
    const before = JSON.stringify(rt.record.earlier ?? []);
    if (JSON.stringify(earlier) === before) return false;
    rt.record.earlier = earlier.length > 0 ? earlier : undefined;
    const persisted = state.folders.find((f) => f.id === rt.record.id);
    if (persisted) persisted.earlier = rt.record.earlier;
    saveState();
    return true;
  }

  async function refreshMembersFor(rt: FolderRuntime) {
    await refreshViewers(rt);
    await refreshEarlier(rt);
    const registry = await readRegistryIn(rt.folderDrive);
    // A removed phone keeps each other drive as it was when it heard.
    const frozen = rt.record.notice?.kind === "removed" ? rt.record.keptUntil : undefined;
    const entries = frozen
      ? []
      : Object.values(registry.members).map((m) => ({
          key: m.key,
          name: m.name,
        }));
    for (const e of frozen ? [] : (rt.record.earlier ?? [])) {
      if (e.keptVersion !== undefined) continue;
      if (!entries.some((x) => x.key === e.key)) entries.push(e);
    }
    const live = new Set(entries.map((e) => e.key));
    live.add(selfKeyOf(rt));
    // A Collaborator made a Viewer keeps their photos up to the version the
    // Admin recorded; their drive is read as a copy at that version.
    // A moved album keeps such a copy in its earlier drives.
    const kept = [
      ...Object.entries(frozen ?? {}).map(([key, keptVersion]) => ({
        key,
        keptVersion,
        name: rt.memberNameCache.get(key) ?? registry.members[key]?.name ?? "Unknown device",
      })),
      ...Object.values(rt.viewers).filter(
        (v) => v.keptVersion !== undefined && !registry.members[v.key],
      ),
      ...(rt.record.earlier ?? []).filter(
        (e) => e.keptVersion !== undefined && !registry.members[e.key] && !rt.viewers[e.key],
      ),
    ];
    for (const [key, drive] of [...rt.memberDrives]) {
      const keptVersion = kept.find((v) => v.key === key)?.keptVersion;
      const stays =
        keptVersion !== undefined
          ? rt.keptAt.get(key) === keptVersion
          : live.has(key) && !rt.keptAt.has(key);
      if (stays) continue;
      rt.memberDrives.delete(key);
      rt.keptAt.delete(key);
      rt.memberNameCache.delete(key);
      try {
        await deps.drives.release(drive);
      } catch {
        // already closed (teardown): expected, quiet
      }
    }
    for (const v of kept) {
      if (rt.memberDrives.has(v.key)) continue;
      await openKeptDrive(rt, v.key, v.keptVersion as number, v.name);
    }
    for (const entry of entries) {
      await loadMemberDrive(rt, entry.key, entry.name);
      // A member who left while this phone was off: their note is already here.
      if (rt.record.role === "creator" && rt.memberDrives.has(entry.key)) {
        void dropMemberWhoLeft(rt, entry.key).catch((e) =>
          log("error", {
            where: "dropMemberWhoLeft",
            folder: short(rt.record.id),
            err: errText(e),
          }),
        );
      }
    }
    // Seed the content index from whatever drives are currently reachable. A
    // drive that is offline is skipped (its entries are already indexed from
    // when it was reachable) — never evicted.
    await seedContentIndex(rt);
    await refreshFormer(rt);
    refreshHeldOfEveryone(rt);
    if (await dropCaughtUpEarlier(rt)) await refreshMembersFor(rt);
  }

  const droppingEarlier = new Set<string>();

  /** Admin: a Collaborator whose new drive is enrolled and lists at least as
   * many photos as their old one no longer needs the old one as a source. Drops
   * it from the album's earlier list. True when something was dropped. */
  async function dropCaughtUpEarlier(rt: FolderRuntime): Promise<boolean> {
    const earlier = rt.record.earlier ?? [];
    if (rt.record.role !== "creator" || earlier.length === 0) return false;
    if (droppingEarlier.has(rt.record.id)) return false;
    droppingEarlier.add(rt.record.id);
    try {
      const registry = await readRegistryIn(rt.folderDrive);
      const removed = Object.keys(await readRemovedIn(rt.folderDrive));
      const removedIds = (key: string) =>
        new Set(removed.filter((k) => k.startsWith(`${key}:`)).map((k) => k.slice(key.length + 1)));
      const done = new Set<string>();
      for (const e of earlier) {
        if (e.keptVersion !== undefined) continue;
        const oldDrive = rt.memberDrives.get(e.key);
        const identity = presence.identities.get(e.key);
        if (!oldDrive || !identity) continue;
        const next = Object.values(registry.members).find(
          (m) => m.key !== e.key && presence.identities.get(m.key) === identity,
        );
        const newDrive = next && rt.memberDrives.get(next.key);
        if (!next || !newDrive) continue;
        const have = await countShownPhotos(newDrive, removedIds(next.key));
        const had = await countShownPhotos(oldDrive, removedIds(e.key));
        if (have >= had) done.add(e.key);
      }
      if (done.size === 0) return false;
      const rest = earlier.filter((e) => !done.has(e.key));
      const file: EarlierFile = { version: 1, earlier: rest };
      await rt.folderDrive.put(DRIVE_PATH_EARLIER, Buffer.from(JSON.stringify(file)));
      const persisted = state.folders.find((f) => f.id === rt.record.id);
      for (const target of persisted ? [rt.record, persisted] : [rt.record]) {
        target.earlier = rest.length > 0 ? rest : undefined;
      }
      saveState();
      deps.onChanged({ cause: "enroll", folderId: rt.record.id });
      return true;
    } catch (e) {
      log("error", { where: "dropCaughtUpEarlier", folder: short(rt.record.id), err: errText(e) });
      return false;
    } finally {
      droppingEarlier.delete(rt.record.id);
    }
  }

  /** Records a photo in the content index so a later re-add dedupes even when
   * the owning drive is momentarily unreachable (issue #43). Idempotent on
   * (sha256, driveKey, id). */
  function indexPhoto(p: IndexedPhoto) {
    const arr = contentIndex.get(p.sha256) ?? [];
    if (arr.some((e) => e.driveKey === p.driveKey && e.id === p.id && e.folderId === p.folderId)) {
      return;
    }
    arr.push(p);
    contentIndex.set(p.sha256, arr);
  }

  /** Drops a photo from the content index once it is removed. */
  function pruneIndex(photoId: string, driveKey: string) {
    for (const arr of contentIndex.values()) {
      const i = arr.findIndex((e) => e.id === photoId && e.driveKey === driveKey);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  /** Best-effort (re)build of the content index from the drives we can currently
   * see. Drives that throw on `list` (unreachable / not downloaded) are skipped,
   * leaving their already-indexed entries intact — that is the whole point of the
   * index: dedupe must not depend on every peer being reachable at add time. */
  async function seedContentIndex(rt: FolderRuntime) {
    const role = rt.record.role;
    const drives: Drive[] = [];
    if (role === "creator" || role === "member") drives.push(rt.selfDrive);
    if (role === "reader" || role === "member") drives.push(rt.folderDrive);
    for (const d of rt.memberDrives.values()) drives.push(d);
    const scans: DriveScan[] = [];
    for (const d of drives) {
      try {
        const entries: DriveEntry[] = [];
        const list = d.list(DRIVE_PATH_PHOTOS);
        for await (const entry of list) entries.push(entry);
        scans.push({ key: d.key, entries });
      } catch (e) {
        // Unreachable drive — its entries are already indexed; skip, don't evict.
        log("error", { where: "drive.scan", drive: short(d.key), err: errText(e) });
        continue;
      }
    }
    const derived = deriveGallery(scans, {}, (k) => rt.memberNameCache.get(k) ?? state.name);
    for (const p of derived) {
      if (!p.sha256) continue;
      indexPhoto({
        id: p.id,
        driveKey: p.driveKey,
        folderId: rt.record.id,
        name: p.name,
        mime: p.mime,
        size: p.size,
        addedAt: p.addedAt,
        sha256: p.sha256,
        ext: p.ext,
        ...(p.hasThumb ? { hasThumb: true as const } : {}),
      });
    }
  }

  /** Re-derive a pending `reader` folder's role when the creator has since
   * approved the join: if this device is now listed in the folder's registry,
   * flip `reader` → `member` in-session and announce the upgrade (issue #52).
   * Returns true when an upgrade happened. No-op for non-reader folders or
   * folders still awaiting approval. Cheap — reads a single registry file. */
  async function upgradePendingRole(rt: FolderRuntime): Promise<boolean> {
    if (rt.record.role !== "reader" || rt.record.moved || rt.record.notice?.kind === "removed")
      return false;
    const isStillReader = () => rt.record.role === "reader" && rt.record.notice?.kind !== "removed";
    // Before the first await: the watcher's refreshViewers drops this phone
    // from rt.viewers meanwhile.
    const wasViewer = rt.upgradingViewer === true || rt.viewers[selfKeyOf(rt)] !== undefined;
    if (wasViewer) rt.upgradingViewer = true;
    const adminName = wasViewer ? await adminNameOf(rt) : undefined;
    const registry = await readRegistryIn(rt.folderDrive);
    const selfKey = selfKeyOf(rt);
    if (!isEnrolled(registry, selfKey)) {
      rt.upgradingViewer = false;
      return false;
    }
    // A second watcher tick may have flipped the role while we waited.
    if (!isStillReader()) return false;
    rt.record.role = "member";
    rt.upgradingViewer = false;
    rt.record.pending = false;
    rt.record.driveKey = selfKey;
    await refreshMembersFor(rt);
    await pruneJoinRequests();
    if (wasViewer) roleChangePush(rt, "reader", "member", adminName);
    else deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey: selfKey });
    return true;
  }

  // --- Archive, delete for everyone (#186). ---------------------------------

  type LifecycleActor = ReturnType<typeof createAlbumLifecycleActor>;
  /** One actor per album, built when first needed. */
  const lifecycles = new Map<string, LifecycleActor>();

  /** Sets the saved lifecycle mark on the runtime's record and the persisted one. */
  function markLifecycle(rt: FolderRuntime, mark: FolderRecord["lifecycle"]) {
    for (const target of [rt.record, state.folders.find((f) => f.id === rt.record.id)]) {
      if (!target) continue;
      if (mark === undefined) delete target.lifecycle;
      else target.lifecycle = mark;
    }
    saveState();
  }

  function lifecyclePort(rt: FolderRuntime): AlbumLifecyclePort {
    return {
      adminListsYou: async () => {
        if (rt.record.role === "member") {
          // A Collaborator the Admin made a Viewer leaves as a Viewer: watch the Viewers list.
          await refreshViewers(rt);
          becomeViewerIfListed(rt);
          return true;
        }
        if (rt.record.role !== "reader" || rt.record.notice?.kind === "removed") return false;
        await refreshViewers(rt);
        return rt.viewers[selfKeyOf(rt)] !== undefined;
      },
      writeLeftNote: async () => {
        const [error] = await writeLeftNote(rt.selfDrive, { at: Date.now() });
        return error ? Either.left(error) : Either.right();
      },
      writeDeleteNote: async () => {
        const [error] = await writeDeleteNote(rt.folderDrive, {
          adminName: state.name,
          at: Date.now(),
        });
        return error ? Either.left(error) : Either.right();
      },
      removeCopy: (keep) => removeAlbumCopy(rt, keep),
      forget: () =>
        forgetDrives(
          rt.folderDrive,
          rt.selfDrive,
          rt.record.selfNs ?? `member/${rt.record.shareKey}`,
        ),
    };
  }

  /** Drops what a Member kept after leaving: the album's drive goes, this phone's own drive in it is released (not deleted: the same invite reopens the same key). Never rejects. */
  async function forgetDrives(album: Drive, self: Drive, selfNs: string): Promise<void> {
    leaveTopic(hex(topicOf(self)));
    leaveTopic(hex(topicOf(album)));
    selfDrives.delete(selfNs);
    try {
      await deps.drives.release(self);
    } catch (e) {
      log("error", { where: "forget.release", drive: short(self.key), err: errText(e) });
    }
    try {
      await deps.drives.purge(album.key);
    } catch (e) {
      log("error", { where: "forget.purge", drive: short(album.key), err: errText(e) });
    }
  }

  /** Removes this phone's copy of an album: the runtime, the other members'
   * drives and, unless `keep` names them, this phone's own drives. Never rejects;
   * safe to run twice. */
  async function removeAlbumCopy(rt: FolderRuntime, keep: Keep): Promise<void> {
    const id = rt.record.id;
    const keys = new Set<string>([
      ...rt.memberDrives.keys(),
      ...(rt.record.earlier ?? []).map((e) => e.key),
    ]);
    const own = new Map<string, Drive>([
      [rt.selfDrive.key, rt.selfDrive],
      [rt.folderDrive.key, rt.folderDrive],
    ]);
    try {
      await unmountRuntime(rt);
    } catch (e) {
      log("error", { where: "removeAlbumCopy.unmount", folder: short(id), err: errText(e) });
    }
    if (keep === "nothing") {
      for (const [key, drive] of own) {
        keys.add(key);
        leaveTopic(hex(topicOf(drive)));
      }
      selfDrives.delete(rt.record.selfNs ?? `member/${rt.record.shareKey}`);
    } else {
      // The Admin's album drive is read-only here; only this phone's own drive holds its photos.
      const mine = rt.record.role === "creator" ? rt.folderDrive : rt.selfDrive;
      await deleteOwnPhotos(mine, { log });
    }
    if (rt.record.role === "creator") {
      for (const code of [rt.record.invite?.code, ...(rt.record.retiredInvites ?? [])]) {
        if (code) leaveTopic(hex(inviteTopic(code, crypto)));
      }
    }
    keys.delete(ownDrive.key);
    for (const key of keys) {
      try {
        await deps.drives.purge(key);
      } catch (e) {
        log("error", { where: "removeAlbumCopy.purge", drive: short(key), err: errText(e) });
      }
    }
    for (const [sha, arr] of contentIndex) {
      const rest = arr.filter((e) => e.folderId !== id);
      if (rest.length === 0) contentIndex.delete(sha);
      else contentIndex.set(sha, rest);
    }
    runtimes.delete(id);
  }

  /** This phone follows the album to its new key: the old album's drives are
   * released (never purged) and its record is replaced by the one the join
   * makes under the same local id. */
  async function retireMovedAlbum(rt: FolderRuntime): Promise<void> {
    const id = rt.record.id;
    try {
      await unmountRuntime(rt);
      leaveTopic(hex(topicOf(rt.folderDrive)));
      await deps.drives.release(rt.folderDrive);
    } catch (e) {
      log("error", { where: "retireMovedAlbum", folder: short(id), err: errText(e) });
    }
    for (const [sha, arr] of contentIndex) {
      const rest = arr.filter((e) => e.folderId !== id);
      if (rest.length === 0) contentIndex.delete(sha);
      else contentIndex.set(sha, rest);
    }
    state.folders = state.folders.filter((f) => f.id !== id);
    runtimes.delete(id);
    lifecycles.delete(id);
    log("move.followed", { folder: short(id) });
  }

  /** Moves an album from the saved list to the gone records. */
  function moveToGone(
    rt: FolderRuntime,
    kind: GoneRecord["kind"],
    adminName?: string,
    selfNs?: string,
    listedIn?: "viewers",
  ) {
    const id = rt.record.id;
    state.folders = state.folders.filter((f) => f.id !== id);
    state.gone = [
      ...state.gone.filter((g) => g.id !== id),
      {
        id,
        name: rt.record.name,
        shareKey: rt.record.shareKey,
        kind,
        ...(adminName === undefined ? {} : { adminName }),
        ...(selfNs === undefined ? {} : { selfNs }),
        ...(listedIn === undefined ? {} : { listedIn }),
        at: Date.now(),
      },
    ];
    if (state.activeFolderId === id) state.activeFolderId = shownFolders()[0]?.id ?? null;
    runtimes.delete(id);
    lifecycles.delete(id);
    saveState();
    deps.onChanged({ cause: "remove", folderId: id });
  }

  function onLifecycleState(rt: FolderRuntime, name: string, payload: unknown) {
    const id = rt.record.id;
    switch (name) {
      case "archived":
        markLifecycle(rt, "archived");
        if (state.activeFolderId === id) {
          state.activeFolderId = shownFolders()[0]?.id ?? null;
          saveState();
        }
        deps.onChanged({ cause: "remove", folderId: id });
        return;
      case "shownInYourAlbums":
        if (rt.record.lifecycle === undefined) return;
        markLifecycle(rt, undefined);
        deps.onChanged({ cause: "add", folderId: id });
        return;
      case "leavingAlbum":
        markLifecycle(rt, "leaving");
        return;
      case "deletingForEveryone":
        markLifecycle(rt, "deleting");
        return;
      case "deletedForEveryone":
        moveToGone(rt, "deletedForEveryone");
        return;
      case "waitingForAdminToSeeYouLeft": {
        const actor = lifecycles.get(id);
        const selfNs = rt.record.selfNs ?? `member/${rt.record.shareKey}`;
        const list = rt.record.role === "reader" ? "viewers" : "members";
        moveToGone(
          rt,
          "waitingForAdminToSeeYouLeft",
          undefined,
          selfNs,
          list === "viewers" ? list : undefined,
        );
        if (actor) {
          lifecycles.set(id, actor);
          watchForAdmin(id, actor, rt.folderDrive, rt.selfDrive, list);
        }
        return;
      }
      case "leftAlbum":
        finishLeave(id);
        return;
      case "deletedByAdmin": {
        const adminName =
          isTextJSON(payload) && typeof payload.adminName === "string"
            ? payload.adminName
            : DEFAULT_ASK_OWNER;
        moveToGone(rt, "deletedByAdmin", adminName);
        return;
      }
    }
  }

  /** Nothing of a left album is on this phone any more: its saved records go. */
  function finishLeave(id: string) {
    const remove = waitingWatchers.get(id);
    waitingWatchers.delete(id);
    remove?.();
    lifecycles.delete(id);
    const wasShown = state.folders.some((f) => f.id === id);
    state.folders = state.folders.filter((f) => f.id !== id);
    state.gone = state.gone.filter((g) => g.id !== id);
    runtimes.delete(id);
    if (state.activeFolderId === id) state.activeFolderId = shownFolders()[0]?.id ?? null;
    saveState();
    if (wasShown) deps.onChanged({ cause: "remove", folderId: id });
  }

  /** Albums a Member left, waiting for the Admin's member list to drop this phone: the stop function of each watcher. */
  const waitingWatchers = new Map<string, () => void>();

  /** Watches the Admin's drive for the list (members or viewers) that drops this phone (or a delete note), and tells the actor. */
  function watchForAdmin(
    id: string,
    actor: LifecycleActor,
    album: Drive,
    self: Drive,
    list: "members" | "viewers",
  ) {
    waitingWatchers.get(id)?.();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let checking = false;
    const check = async () => {
      if (checking || closed || actor.state.name !== "waitingForAdminToSeeYouLeft") return;
      checking = true;
      try {
        const deleted = await readDeleteNote(album, { log, timeoutMs: 2_000 });
        if (deleted) {
          actor.send({ type: "deleteHeard", payload: deleted });
          return;
        }
        // Text that is missing reads as "no file": an unreplicated drive is not a drop.
        const text = await readText(
          album,
          list === "viewers" ? DRIVE_PATH_VIEWERS : DRIVE_PATH_MEMBERS,
          { timeout: 2_000 },
        );
        if (adminDroppedYou(text, self.key, list)) actor.send({ type: "adminSawYouLeave" });
      } finally {
        checking = false;
      }
    };
    const run = () =>
      void check().catch((e) =>
        log("error", { where: "watchForAdmin", album: short(id), err: errText(e) }),
      );
    const off = album.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 400);
    });
    waitingWatchers.set(id, () => {
      off();
      if (timer) clearTimeout(timer);
    });
    run();
  }

  /** The album's actor, started from the saved mark (and a delete note already read). */
  function lifecycleOf(rt: FolderRuntime, deleteNote?: { adminName: string }): LifecycleActor {
    const existing = lifecycles.get(rt.record.id);
    if (existing) return existing;
    const start = lifecycleStart({
      role: rt.record.role,
      saved: rt.record.lifecycle ?? "shown",
      ...(deleteNote ? { deleteNote } : {}),
    });
    const actor = createAlbumLifecycleActor({ clock: RealClock(), port: lifecyclePort(rt), start });
    lifecycles.set(rt.record.id, actor);
    actor.on("change", {
      fn: (snapshot) => onLifecycleState(rt, snapshot.path[0] ?? "", snapshot.payload),
    });
    return actor;
  }

  /** Reads the album's delete note (not the Admin's own) and, if the Admin deleted it, removes this phone's copy. */
  async function checkDeleteNote(rt: FolderRuntime, timeoutMs: number): Promise<void> {
    if (rt.record.role === "creator") return;
    const note = await readDeleteNote(rt.folderDrive, { log, timeoutMs });
    if (!note) return;
    const actor = lifecycleOf(rt, note);
    const name = actor.state.name;
    if (name !== "shownInYourAlbums" && name !== "archived") return;
    actor.send({ type: "roleSeen", payload: { role: rt.record.role } });
    actor.send({ type: "deleteHeard", payload: note });
  }

  const checkingRemoved = new Set<string>();

  /** Reads the Admin's removed note; if it lists this phone, the album turns read-only. */
  async function checkRemovedNote(rt: FolderRuntime, timeoutMs: number): Promise<void> {
    if (rt.record.role === "creator" || rt.record.notice?.kind === "removed") return;
    const id = rt.record.id;
    if (checkingRemoved.has(id)) return;
    checkingRemoved.add(id);
    try {
      const keys = await readRemovedPeople(rt.folderDrive, { log, timeoutMs });
      if (keys.includes(selfKeyOf(rt))) await markRemoved(rt);
    } finally {
      checkingRemoved.delete(id);
    }
  }

  /** This phone was removed: the album stays on it, read-only, with the photos it has. */
  async function markRemoved(rt: FolderRuntime) {
    const persisted = state.folders.find((f) => f.id === rt.record.id);
    const keptUntil: Record<string, number> = {};
    for (const [key, drive] of rt.memberDrives) {
      if (key === selfKeyOf(rt)) continue;
      keptUntil[key] = rt.keptAt.get(key) ?? drive.version();
    }
    for (const target of persisted ? [rt.record, persisted] : [rt.record]) {
      target.role = "reader";
      target.driveKey = "";
      target.pending = false;
      target.notice = { kind: "removed" };
      target.keptUntil = keptUntil;
    }
    saveState();
    await refreshMembersFor(rt);
    armFolderWatchers(rt);
    log("removed.heard", {
      folder: short(rt.record.id),
      kept: Object.keys(keptUntil).length,
    });
    deps.onChanged({ cause: "enroll", folderId: rt.record.id });
  }

  /** Sends one input to the album's actor and answers when it is at rest. */
  async function changeLifecycle(
    rt: FolderRuntime,
    type: "archive" | "restore" | "deleteForEveryone" | "leave",
  ): Promise<EitherResult<{ ok: boolean }>> {
    const actor = lifecycleOf(rt);
    const name = actor.state.name;
    if (name !== "shownInYourAlbums" && name !== "archived") {
      return err(PhotoError.ALBUM_NOT_CHANGED, "The album is being changed");
    }
    actor.send({ type: "roleSeen", payload: { role: rt.record.role } });
    actor.send({ type });
    await actor.settled();
    const snapshot = actor.snapshot();
    const reason = snapshot.context.error;
    if (reason !== null && snapshot.path[0] === "shownInYourAlbums") {
      return err(PhotoError.ALBUM_NOT_CHANGED, reason);
    }
    return ok({ ok: true });
  }

  async function unmountRuntime(rt: FolderRuntime) {
    for (const remove of rt.watcherRemoves) {
      try {
        remove();
      } catch {
        // already removed
      }
    }
    rt.watcherRemoves.clear();
    for (const route of rt.mounted) lazyMedia.drop(route);
    rt.mounted.clear();
    // Issue #95: tear down this folder's member-drive swarm joins (and close
    // the drives) on unmount so a folder switch or re-enroll doesn't leak one
    // join per member. The device-identity `ownDrive` join is never present
    // here — `loadMemberDrive` skips selfKey — so it is preserved across
    // folder switches.
    for (const drive of rt.memberDrives.values()) {
      leaveTopic(drive.discoveryKey);
      try {
        await deps.drives.release(drive);
      } catch {
        // already closed (teardown): expected, quiet
      }
    }
    rt.memberDrives.clear();
    rt.memberNameCache.clear();
    const spool = spoolDirFor(rt.record.id);
    try {
      fs.rmSync(spool, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  async function listPhotosIn(rt: FolderRuntime): Promise<Photo[]> {
    const selfKey = selfKeyOf(rt);
    const sources = galleryDrives({
      role: rt.record.role,
      folderDrive: rt.folderDrive,
      selfDrive: rt.selfDrive,
      memberDrives: rt.memberDrives,
      removed: rt.record.notice?.kind === "removed",
    });
    const derived = await listGallery(sources, {
      removedFrom: rt.folderDrive,
      memberName: (k) => (k === selfKey ? state.name : rt.memberNameCache.get(k)),
      log,
    });
    const driveByKey = new Map(sources.map((s) => [s.key, s.drive]));

    const people = await albumPeople(rt);
    const photos: Photo[] = [];
    const listed: { id: string; ext: string; driveKey: string }[] = [];
    for (const d of derived) {
      const drive = driveByKey.get(d.driveKey);
      if (!drive) continue;
      listed.push({ id: d.id, ext: d.ext, driveKey: d.driveKey });
      photos.push({
        id: d.id,
        ...(await servePhoto(rt, drive, d.driveKey, d)),
        name: d.name,
        mime: d.mime,
        size: d.size,
        addedAt: d.addedAt,
        member: { key: d.driveKey, name: d.memberName },
        ...(d.sha256 ? { sha256: d.sha256 } : {}),
        ...(d.takenAt ? { takenAt: d.takenAt } : {}),
        folderId: rt.record.id,
        mine: d.driveKey === selfKey,
        holders: holdersFor({
          photo: { id: d.id, driveKey: d.driveKey, memberName: d.memberName },
          selfKey,
          people,
          held: rt.held,
          former: rt.former,
        }),
      });
    }
    if (!rt.heldBackfilled) {
      rt.heldBackfilled = true;
      void startHolding(rt)
        .then(() => backfillHeld(rt, listed))
        .catch((e) => log("error", { where: "backfillHeld", err: errText(e) }));
    }
    return photos;
  }

  /**
   * Serve a photo's display copy and thumbnail on the loopback server. Nothing
   * is downloaded here: each route spools its bytes off the drive the first
   * time the Web layer loads it (see `lazy-media.ts`).
   */
  async function servePhoto(
    rt: FolderRuntime,
    drive: Drive,
    driveKey: string,
    p: { id: string; ext: string; mime: string; hasThumb?: true },
  ): Promise<{ url: string; thumbUrl?: string }> {
    const origin = await deps.server.origin();
    const serve = (drivePath: string, spoolName: string, mime: string, display = false) => {
      // `p.id`/`p.ext` derive from untrusted drive photo keys, so the spool
      // name must be filesystem-safe — never interpolate them raw (issue #71).
      const route = `/photos/${rt.record.id}/${spoolName}`;
      const spoolPath = path.join(spoolDirFor(rt.record.id), spoolName);
      lazyMedia.serve(route, {
        mime,
        open: async () => {
          await spoolToFile(drive, drivePath, spoolPath);
          if (display && driveKey !== selfKeyOf(rt)) {
            void noteHeld(rt, p.id).catch((e) =>
              log("error", { where: "noteHeld", err: errText(e) }),
            );
          }
          return spoolPath;
        },
      });
      rt.mounted.add(route);
      return `${origin}${route}`;
    };
    const url = serve(
      `${DRIVE_PATH_PHOTOS}/${p.id}${p.ext}`,
      spoolNameFor(driveKey, p.id, p.ext),
      p.mime,
      true,
    );
    if (!p.hasThumb) return { url };
    const thumbUrl = serve(
      `${DRIVE_PATH_THUMBS}/${p.id}${RENDITION_EXT}`,
      spoolNameFor(driveKey, p.id, `thumb${RENDITION_EXT}`),
      "image/jpeg",
    );
    return { url, thumbUrl };
  }

  /** Stop serving a photo that left the album, and drop its cached bytes. */
  function forgetPhoto(rt: FolderRuntime, driveKey: string, id: string, ext: string) {
    const names = [
      spoolNameFor(driveKey, id, ext),
      spoolNameFor(driveKey, id, `thumb${RENDITION_EXT}`),
    ];
    for (const name of names) {
      const route = `/photos/${rt.record.id}/${name}`;
      lazyMedia.drop(route);
      rt.mounted.delete(route);
      try {
        fs.rmSync(path.join(spoolDirFor(rt.record.id), name), { force: true });
      } catch {
        // never spooled
      }
    }
  }

  async function spoolToFile(drive: Drive, drivePath: string, spoolPath: string) {
    if (fs.existsSync(spoolPath)) return;
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    // Unique tmp per call so concurrent spools of the same photo never collide;
    // rename is atomic (last write wins, content is identical).
    const tmp = `${spoolPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    let ok = false;
    try {
      const stream = drive.createReadStream(drivePath);
      await pumpToFile(stream, tmp, MAX_SPOOL_BYTES, fs);
      fs.renameSync(tmp, spoolPath);
      ok = true;
    } finally {
      if (!ok) {
        // A failed or oversized/capped spool (e.g. a malicious photo past
        // MAX_SPOOL_BYTES, or a disk error) must not leave its staging file
        // behind — clean it up so the cache spool dir never accumulates orphan
        // `*.tmp` files (issues #90/#92). The writer opens its destination file
        // asynchronously, so a fast failure can race the open: the synchronous
        // unlink below sees ENOENT (file not yet on disk) while the open still
        // completes and creates it afterwards. Remove it now and again on the
        // next tick to catch that late open — this is the load-dependent CI
        // flake reported in #142.
        try {
          fs.unlinkSync(tmp);
        } catch {
          // already gone
        }
        setImmediate(() => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // already gone
          }
        });
      }
    }
  }

  async function seedSamplePhotos(drive: Drive) {
    try {
      const list = drive.list(DRIVE_PATH_PHOTOS);
      for await (const _ of list) return; // non-empty — already seeded
    } catch {
      // empty
    }
    const samples = [
      { name: "sunset.jpg", data: SAMPLE_1, mime: "image/jpeg" },
      { name: "peaks.jpg", data: SAMPLE_2, mime: "image/jpeg" },
      { name: "lake.jpg", data: SAMPLE_3, mime: "image/jpeg" },
    ];
    const addedAt = Date.now() - samples.length * 60_000;
    for (const [i, sample] of samples.entries()) {
      const id = newId(deps.crypto);
      await drive.put(`${DRIVE_PATH_PHOTOS}/${id}.jpg`, sample.data, {
        metadata: { addedAt: addedAt + i * 60_000, name: sample.name, mime: sample.mime },
      });
    }
    console.log("[justus] seeded sample photos");
  }

  /** Contain an import path and read it (#93/#97). Normalize `..`/relative
   * segments (path.resolve) and reject anything that escapes an allowed root
   * (the native picker copies selections into `cacheDir`), then reject any
   * symlink component (which could point outside the root). The symlink walk
   * uses lstat so neither the final entry nor an ancestor is followed. Every
   * check runs before any bytes are read. */
  function readImport(
    filePath: string,
  ):
    | [CoreError, null]
    | [null, { resolved: string; bytes: import("bare-buffer").Buffer; size: number }] {
    const resolved = path.resolve(filePath);
    const matchedRoot = importRoots.find((root) => isWithinRoot(resolved, root));
    if (!matchedRoot) {
      return err(PhotoError.FORBIDDEN, `Import path escapes allowed roots: ${filePath}`);
    }
    try {
      assertNoSymlink(resolved, matchedRoot);
    } catch {
      return err(PhotoError.FORBIDDEN, `Import path contains a symlink: ${filePath}`);
    }
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return err(PhotoError.NOT_FOUND, `No file at ${filePath}`);
    }
    if (!stat.isFile()) {
      return err(PhotoError.NOT_FOUND, `Not a file: ${filePath}`);
    }
    try {
      const bytes = fs.readFileSync(resolved) as unknown as import("bare-buffer").Buffer;
      return [null, { resolved, bytes, size: stat.size }];
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(ErrorCode.HOST_ERROR, `Failed to read file: ${message}`);
    }
  }

  /** Lowercased extension of a file name; `"."` alone counts as none. */
  const extOf = (name: string) => path.extname(name).toLowerCase().replace(/^\.$/, "");

  async function addFromPath(
    filePath: string,
    originalName?: string,
    folderId?: string,
    opts: AddOptions = {},
  ): Promise<EitherResult<Photo>> {
    const rt = runtimeFor(folderId);
    if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No album is active");
    if (rt.record.role === "reader") {
      return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
    }
    const [displayErr, display] = readImport(filePath);
    if (displayErr) return [displayErr, null];
    // With a thumbnail, `filePath` is a display copy the adding device made
    // (2560 px JPEG) and the original stays on that device. Without
    // one, the file is shared as it is (older hosts, tests).
    let thumb: import("bare-buffer").Buffer | null = null;
    let source = display.bytes;
    if (opts.thumb) {
      const [thumbErr, t] = readImport(opts.thumb);
      if (thumbErr) return [thumbErr, null];
      const displayExt = extOf(display.resolved);
      const thumbExt = extOf(t.resolved);
      if (displayExt !== RENDITION_EXT || thumbExt !== RENDITION_EXT) {
        return err(
          PhotoError.UNSUPPORTED_FORMAT,
          `Not a shareable copy: ${displayExt} / ${thumbExt}`,
        );
      }
      thumb = t.bytes;
      if (opts.original) {
        const [originalErr, original] = readImport(opts.original);
        if (originalErr) return [originalErr, null];
        source = original.bytes;
      }
    }
    // The original filename travels in via `originalName` (e.g. the real name
    // of an in-band `addBytes` upload, which is otherwise lost because the bytes
    // are staged to a transient `upload-<id>` file — issue #82). Fall back to
    // the staged file's basename only when no name was supplied (the
    // host-picked `add(path)` flow, where basename is the real name).
    // The name stays the one the user knows (IMG_1234.HEIC) even when the
    // shared copy is a JPEG: `mime` says what the bytes are.
    const name =
      originalName && originalName.trim() ? originalName.trim() : path.basename(display.resolved);
    const ext = thumb ? extOf(display.resolved) : extOf(name);
    const mime = guessMime(ext);
    // Content dedupe (#20): the same bytes must not create a second entry. The
    // hash is of the original, so re-picking a photo dedupes even though its
    // shared copy is re-encoded. A Web layer that encoded the copies itself
    // sends the original's hash along. bare-crypto's HashAlgorithm spells it
    // "sha-256" at the type level.
    const sha256 = isSha256Hex(opts.sha256)
      ? opts.sha256
      : crypto.createHash("sha-256").update(source).digest("hex");
    // Reachability-independent content dedupe (issue #43): consult the
    // in-session content index instead of re-scanning every drive (which silently
    // skips unreachable peers and would let a re-add of our own bytes slip
    // through). Only a copy this device already holds short-circuits the add — a
    // matching sha256 on *another* member's drive must NOT be adopted (issue
    // #49): that would leave the "added" photo unowned and unremovable for us, so
    // we fall through and write a local copy below.
    const selfKey = selfKeyOf(rt);
    // A creator writes to the folder's own drive; a member writes to its drive
    // for this album only (#195), never one another album also reads.
    const targetDrive = rt.selfDrive;
    const ownIdx = contentIndex
      .get(sha256)
      ?.find((e) => e.driveKey === selfKey && e.folderId === rt.record.id);
    if (ownIdx) {
      // Serve the same route the original add did, so the re-add's URL matches
      // what `listPhotosIn` derives (issues #81/#83/#87).
      return ok({
        id: ownIdx.id,
        ...(await servePhoto(rt, targetDrive, selfKey, {
          id: ownIdx.id,
          ext: ownIdx.ext,
          mime: ownIdx.mime,
          ...(ownIdx.hasThumb ? { hasThumb: true as const } : {}),
        })),
        name: ownIdx.name,
        mime: ownIdx.mime,
        size: ownIdx.size,
        addedAt: ownIdx.addedAt,
        member: { key: ownIdx.driveKey, name: state.name },
        ...(ownIdx.sha256 ? { sha256: ownIdx.sha256 } : {}),
        folderId: rt.record.id,
        mine: true,
      });
    }
    const id = newId(deps.crypto);
    // Re-encoding drops EXIF, so the date comes from the original: as the host
    // read it (it can parse HEIC), else from the bytes we hold.
    const takenAt =
      typeof opts.takenAt === "string" && TAKEN_AT_RE.test(opts.takenAt)
        ? opts.takenAt
        : readTakenAt(source);
    const [writeErr, added] = await addPhoto(targetDrive, {
      id,
      ext,
      bytes: display.bytes,
      ...(thumb ? { thumb } : {}),
      name,
      mime,
      sha256,
      ...(takenAt ? { takenAt } : {}),
    });
    if (writeErr) return err(ErrorCode.PLUGIN_ERROR, `Failed to store photo: ${writeErr.message}`);
    // Record the new content in the index so a later re-add dedupes even if this
    // drive is momentarily unreachable at that moment (issue #43).
    indexPhoto({
      id,
      driveKey: selfKey,
      folderId: rt.record.id,
      name,
      mime,
      size: display.size,
      addedAt: added.addedAt,
      sha256,
      ext,
      ...(thumb ? { hasThumb: true as const } : {}),
    });
    deps.onChanged({ cause: "add", folderId: rt.record.id, memberKey: selfKey });
    return ok({
      id,
      ...(await servePhoto(rt, targetDrive, selfKey, {
        id,
        ext,
        mime,
        ...(thumb ? { hasThumb: true as const } : {}),
      })),
      name,
      mime,
      size: display.size,
      addedAt: added.addedAt,
      ...(takenAt ? { takenAt } : {}),
      member: { key: selfKey, name: state.name },
      folderId: rt.record.id,
      mine: true,
    });
  }

  function toSummary(rt: FolderRuntime): FolderSummary {
    return albumSummary(rt, { ownIdentity: ownDrive.key });
  }

  type AlbumPerson = {
    key: string;
    name: string;
    admin: boolean;
    self: boolean;
    viewer: boolean;
  };

  /** Everyone in the album as this phone sees it: this phone, the Admin, the
   * enrolled members, the Viewers, and (on the Admin's phone) people still moving. */
  async function albumPeople(rt: FolderRuntime): Promise<AlbumPerson[]> {
    const registry = await readRegistryIn(rt.folderDrive);
    const selfKey = selfKeyOf(rt);
    // Dedupe self in case the registry already lists this device (issue #89).
    const isAdmin = rt.record.role === "creator";
    const adminKey = rt.record.shareKey;
    const person = (key: string, name: string, viewer: boolean): AlbumPerson => ({
      key,
      name,
      admin: false,
      self: false,
      viewer,
    });
    return [
      {
        key: selfKey,
        name: state.name,
        admin: isAdmin,
        self: true,
        viewer: rt.record.role === "reader" && rt.viewers[selfKey] !== undefined,
      },
      // A member sees the Admin too: the registry only lists enrolled writers.
      ...(!isAdmin && selfKey !== adminKey
        ? [{ ...person(adminKey, await readDeviceName(rt.folderDrive), false), admin: true }]
        : []),
      ...Object.values(registry.members)
        .filter((m) => m.key !== selfKey && m.key !== adminKey)
        .map((m) => person(m.key, m.name, false)),
      ...Object.values(rt.viewers)
        .filter((v) => v.key !== selfKey && v.key !== adminKey && !registry.members[v.key])
        .sort((a, b) => a.addedAt - b.addedAt)
        .map((v) => person(v.key, v.name, true)),
      ...(isAdmin
        ? [
            ...Object.values(rt.record.moving ?? {}),
            ...Object.values(rt.record.movingUnknown ?? {}),
          ]
            .filter((m, i, all) => all.findIndex((o) => o.key === m.key) === i)
            .map((m) => person(m.key, m.name, m.role === "reader"))
        : []),
    ];
  }

  /** The drive a person's holding record is read from, when this phone has it open. */
  function driveOfPerson(rt: FolderRuntime, key: string): Drive | undefined {
    if (key === selfKeyOf(rt)) return undefined;
    const member = rt.memberDrives.get(key);
    if (member) return member;
    if (key === rt.record.shareKey && rt.folderDrive !== rt.selfDrive) return rt.folderDrive;
    return viewerDeviceDrives.get(key)?.drive;
  }

  function sameReport(a: HeldReport | undefined, b: HeldReport): boolean {
    if (a === undefined || a.kind !== b.kind) return false;
    if (a.kind === "silent" || b.kind === "silent") return true;
    if (a.ids.size !== b.ids.size) return false;
    for (const id of a.ids) if (!b.ids.has(id)) return false;
    return true;
  }

  /** Reads another phone's record. A failed read never replaces a report already known. */
  async function refreshHeld(rt: FolderRuntime, key: string, drive: Drive) {
    const prev = rt.held.get(key);
    const next = await readHeld(drive, { timeoutMs: 1_500, log });
    if (next.kind === "silent" && prev?.kind === "reports") return;
    if (sameReport(prev, next)) return;
    rt.held.set(key, next);
    deps.onChanged({ cause: "holders", folderId: rt.record.id });
  }

  function sameFormer(a: FormerPerson[], b: FormerPerson[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((p, i) => {
      const q = b[i];
      return (
        p.name === q.name &&
        p.identity === q.identity &&
        p.left === q.left &&
        p.ids.size === q.ids.size &&
        [...p.ids].every((id) => q.ids.has(id))
      );
    });
  }

  /** Reads the Admin's list of people who left. A change pushes the photos' holders. */
  async function refreshFormer(rt: FolderRuntime) {
    const next = await readFormer(rt.folderDrive, log);
    if (sameFormer(rt.former, next)) return;
    rt.former = next;
    deps.onChanged({ cause: "holders", folderId: rt.record.id });
  }

  /** Admin: a person is going. Notes what they had, so their copies are still named. */
  async function formerSnapshot(
    rt: FolderRuntime,
    memberKey: string,
  ): Promise<{ name: string; ids: ReadonlySet<string> } | undefined> {
    const report = rt.held.get(memberKey);
    if (report?.kind !== "reports" || report.ids.size === 0) return undefined;
    const name = (await albumPeople(rt)).find((p) => p.key === memberKey)?.name;
    return name === undefined ? undefined : { name, ids: report.ids };
  }

  function markLeft<T extends object>(snapshot: T | undefined): (T & { left: true }) | undefined {
    return snapshot && { ...snapshot, left: true };
  }

  async function noteFormer(
    rt: FolderRuntime,
    snapshot: { name: string; ids: ReadonlySet<string>; left?: true } | undefined,
    identity: string | undefined,
  ) {
    if (snapshot === undefined) return;
    const [noteErr] = await addFormer(
      rt.folderDrive,
      { ...snapshot, ...(identity !== undefined ? { identity } : {}) },
      log,
    );
    if (noteErr) log("error", { where: "noteFormer", err: noteErr.message });
    await refreshFormer(rt);
  }

  /** The identity a drive's `/device.json` proves, if any. */
  async function identityOfDrive(drive: Drive): Promise<string | undefined> {
    const device = verifiedDeviceIdentity((await readText(drive, DRIVE_PATH_DEVICE)) ?? "", {
      driveKey: drive.key,
      verify: (p) => deps.drives.verifyIdentity(p),
    });
    return device.status === "verified" ? device.identityKey : undefined;
  }

  /** Admin: this person is back in the album, so they are no longer "former". */
  async function forgetFormer(rt: FolderRuntime, identity: string | undefined) {
    if (identity === undefined) return;
    const [dropErr, dropped] = await dropFormer(rt.folderDrive, identity, log);
    if (dropErr) log("error", { where: "forgetFormer", err: dropErr.message });
    if (dropped) await refreshFormer(rt);
  }

  function refreshHeldOfEveryone(rt: FolderRuntime) {
    void albumPeople(rt)
      .then((people) => {
        for (const { key } of people) {
          const drive = driveOfPerson(rt, key);
          if (drive) {
            void refreshHeld(rt, key, drive).catch((e) =>
              log("error", { where: "refreshHeld", err: errText(e) }),
            );
          }
        }
      })
      .catch((e) => log("error", { where: "refreshHeldOfEveryone", err: errText(e) }));
  }

  function refreshViewerHeld(keyHex: string, drive: Drive) {
    for (const rt of runtimes.values()) {
      if (!rt.viewers[keyHex]) continue;
      void refreshHeld(rt, keyHex, drive).catch((e) =>
        log("error", { where: "refreshHeld", err: errText(e) }),
      );
    }
  }

  /** Writes this phone's marker and reads back what it already holds. Once per own drive. */
  async function startHolding(rt: FolderRuntime) {
    const drive = rt.selfDrive;
    if (rt.held.has(drive.key)) return;
    rt.held.set(drive.key, { kind: "silent" });
    const [markerErr] = await ensureHoldingMarker(drive);
    if (markerErr) log("error", { where: "holding.marker", err: markerErr.message });
    const report = await readHeld(drive, { timeoutMs: 2_000, log });
    const current = rt.held.get(drive.key);
    const ids = new Set<string>();
    for (const r of [report, current])
      if (r?.kind === "reports") for (const id of r.ids) ids.add(id);
    rt.held.set(
      drive.key,
      ids.size > 0 || report.kind === "reports" ? { kind: "reports", ids } : report,
    );
    if (ids.size > 0) deps.onChanged({ cause: "holders", folderId: rt.record.id });
  }

  const heldPending = new Set<string>();

  /** A full copy of the photo is now on this phone: record it. */
  async function noteHeld(rt: FolderRuntime, id: string) {
    const drive = rt.selfDrive;
    const mine = rt.held.get(drive.key);
    if (mine?.kind === "reports" && mine.ids.has(id)) return;
    const slot = `${rt.record.id}:${id}`;
    if (heldPending.has(slot)) return;
    heldPending.add(slot);
    try {
      const [writeErr, wrote] = await markHeld(drive, id);
      if (writeErr) {
        log("error", { where: "holding.mark", err: writeErr.message });
        return;
      }
      if (!wrote) return;
      const now = rt.held.get(drive.key);
      const ids = new Set(now?.kind === "reports" ? now.ids : []);
      ids.add(id);
      rt.held.set(drive.key, { kind: "reports", ids });
      deps.onChanged({ cause: "holders", folderId: rt.record.id });
    } finally {
      heldPending.delete(slot);
    }
  }

  /** Photos opened before holding records existed: their display copy is already spooled. */
  async function backfillHeld(
    rt: FolderRuntime,
    photos: ReadonlyArray<{ id: string; ext: string; driveKey: string }>,
  ) {
    const drive = rt.selfDrive;
    const mine = rt.held.get(drive.key);
    let marked = 0;
    for (const p of photos) {
      if (p.driveKey === drive.key) continue;
      if (mine?.kind === "reports" && mine.ids.has(p.id)) continue;
      const spooled = path.join(spoolDirFor(rt.record.id), spoolNameFor(p.driveKey, p.id, p.ext));
      if (!fs.existsSync(spooled)) continue;
      await ensureHoldingMarker(drive);
      const [writeErr, wrote] = await markHeld(drive, p.id);
      if (writeErr) {
        log("error", { where: "holding.backfill", err: writeErr.message });
        continue;
      }
      if (!wrote) continue;
      const now = rt.held.get(drive.key);
      const ids = new Set(now?.kind === "reports" ? now.ids : []);
      ids.add(p.id);
      rt.held.set(drive.key, { kind: "reports", ids });
      marked++;
    }
    log("holding.backfill", { folder: short(rt.record.id), marked });
    if (marked > 0) deps.onChanged({ cause: "holders", folderId: rt.record.id });
  }

  async function computeStatus(): Promise<SyncStatus> {
    const rt = activeRuntime();
    if (!rt) {
      // No folder yet — report an empty-but-valid status with the device name.
      return {
        folder: {
          id: "",
          name: "",
          role: "reader",
          shareKey: "",
          driveKey: "",
          members: 0,
          addedAt: 0,
        },
        name: state.name,
        driveKey: "",
        discoveryKey: ownDrive.discoveryKey,
        peers: network.connectionCount(),
        photos: 0,
        members: [],
        updateNeeded,
        peersBehind: [...peersBehind],
      };
    }
    const selfKey = selfKeyOf(rt);
    const memberList: SyncMember[] = (await albumPeople(rt)).map((person) =>
      person.self
        ? {
            key: selfKey,
            name: state.name,
            admin: person.admin,
            connected: true,
            identity: ownDrive.key,
            ...(rt.record.role === "reader" && rt.viewers[selfKey] ? { viewer: true } : {}),
          }
        : {
            key: person.key,
            name: person.name,
            admin: person.admin,
            ...memberPresence(presence, person.key),
            ...(person.viewer ? { viewer: true as const } : {}),
          },
    );
    const photos = (await listPhotosIn(rt)).length;
    const role = rt.record.role;
    return {
      folder: toSummary(rt),
      name: state.name,
      driveKey: role === "reader" ? "" : selfKey,
      discoveryKey: ownDrive.discoveryKey,
      peers: network.connectionCount(),
      photos,
      members: memberList,
      updateNeeded,
      peersBehind: [...peersBehind],
    };
  }

  /**
   * Read pending join-request outboxes off requester drives announced on a
   * creator folder's topic.
   *
   * Join-request transport:
   *  - A requester that can't enroll writes `/requests.json` (keyed by the
   *    target share key) onto its identity drive, then joins the album's topic
   *    as a server so the Admin's device connects to it.
   *  - On every connection both sides send their identity drive key over the
   *    identity channel (`peer-identity.ts`); the swarm's own `remotePublicKey`
   *    is a per-boot noise key, not a drive, so it cannot name the outbox.
   *  - `requests()` opens each identity drive learned this session read-only
   *    and keeps the outbox entries whose share key matches this album.
   */
  const lastRequestCount = new Map<string, number>();
  async function readRequestsFromPeers(rt: FolderRuntime): Promise<FoundJoinRequest[]> {
    const openOutbox = (key: string) =>
      openPeerOutbox(key).then(
        (drive): OpenResult<Drive> => [null, drive],
        (e): OpenResult<Drive> => [e instanceof Error ? e : new Error(String(e)), null],
      );
    const folderOf = (inviteCode: string | undefined) => ({
      id: rt.record.id,
      name: rt.record.name,
      shareKey: rt.record.shareKey,
      inviteCode,
    });
    const { requests: current, ambiguous } = await readJoinRequests(openOutbox, {
      identities: peerIdentities,
      folder: folderOf(rt.record.invite?.code),
      log,
    });
    const found = [...current];
    // Requests held at a Remove stay listed through the code they asked with.
    const heldByCode = new Map<string, string[]>();
    for (const [identity, code] of Object.entries(rt.record.heldAsks ?? {})) {
      heldByCode.set(code, [...(heldByCode.get(code) ?? []), identity]);
    }
    for (const [code, identities] of heldByCode) {
      const held = await readJoinRequests(openOutbox, {
        identities,
        folder: folderOf(code),
        log,
      });
      for (const f of held.requests) {
        if (!f.viaInvite) continue;
        if (found.some((c) => c.request.requesterKey === f.request.requesterKey)) continue;
        found.push({ ...f, held: true });
      }
    }
    for (const key of ambiguous) {
      requesterIdentity.delete(key);
      inviteRequesters.delete(key);
    }
    for (const f of found) {
      const key = f.request.requesterKey;
      requesterIdentity.set(key, f.identity);
      if (f.viaInvite) inviteRequesters.add(key);
      else inviteRequesters.delete(key);
    }
    // Logged on change only: the web layer polls this on every push.
    if (lastRequestCount.get(rt.record.id) !== found.length) {
      lastRequestCount.set(rt.record.id, found.length);
      log("requests.found", {
        folder: short(rt.record.id),
        count: found.length,
        peers: peerIdentities.size,
      });
    }
    return found;
  }

  function announceRequestInbox() {
    for (const rt of runtimes.values()) {
      if (rt.record.role === "creator")
        deps.onChanged({ cause: "request", folderId: rt.record.id });
    }
  }

  function openPeerOutbox(keyHex: string): Promise<Drive> {
    let opening = peerOutboxes.get(keyHex);
    if (!opening) {
      opening = openDriveWithTopic(keyHex, { server: false }).then((drive) => {
        peerOutboxDrives.set(keyHex, drive);
        drive.onChange(() => {
          announceRequestInbox();
          void deliverAnswers(keyHex).catch(answerErr("deliver"));
        });
        return drive;
      });
      // Unreachable this time: let a later `requests()` try again.
      opening.catch(() => peerOutboxes.delete(keyHex));
      peerOutboxes.set(keyHex, opening);
    }
    return opening;
  }

  /** Opens a Viewer's drive to read its `/device.json` only. Not awaited by
   * presence; a failed open is forgotten so the next refresh retries. */
  function openViewerDevice(keyHex: string) {
    if (viewerDevices.has(keyHex) || closed) return;
    const opening = openDriveWithTopic(keyHex, { server: false }).then((drive) => {
      if (closed) {
        void deps.drives.release(drive).catch(() => {});
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const off = drive.onChange(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          refreshPresence();
          refreshViewerHeld(keyHex, drive);
          dropViewersWhoLeft(keyHex, drive);
        }, 400);
      });
      viewerDeviceDrives.set(keyHex, {
        drive,
        off: () => {
          if (timer) clearTimeout(timer);
          off();
        },
      });
      refreshPresence();
      refreshViewerHeld(keyHex, drive);
      dropViewersWhoLeft(keyHex, drive);
    });
    opening.catch(() => viewerDevices.delete(keyHex));
    viewerDevices.set(keyHex, opening);
  }

  /** The peer on `connId` announced peer protocol `remote`. */
  function onPeerVersion(connId: number, remote: number) {
    const c = conns.get(connId);
    if (!c) return;
    const own = deps.peerProtocol ?? PEER_PROTOCOL;
    c.protocol = remote;
    if (remote === own) return;
    if (remote > own) {
      c.refused = "newer";
      if (!updateNeeded) {
        updateNeeded = true;
        deps.onChanged({ cause: "version" });
      }
      network.drop(connId);
      return;
    }
    c.refused = "older";
    // Its identity greeting names it; without one, give up after 5 s.
    const timer = setTimeout(() => network.drop(connId), 5_000);
    timer.unref?.();
  }

  /** Records the name of a peer on an older Justus, then drops it. */
  async function noteOlderPeer(connId: number, identity: string) {
    const c = conns.get(connId);
    if (!c || c.noted) return;
    c.noted = true;
    const name =
      (await withTimeout(
        openPeerOutbox(identity).then(async (drive) => {
          // The file may not have replicated yet: wait for it.
          while (!closed) {
            await drive.update();
            if ((await readText(drive, DRIVE_PATH_DEVICE)) !== null) return readDeviceName(drive);
            await sleep(100);
          }
        }),
        5_000,
      ).catch(() => undefined)) ?? "Someone";
    if (!peersBehind.includes(name) && peersBehind.length < MAX_PEERS_BEHIND) {
      peersBehind.push(name);
      deps.onChanged({ cause: "version" });
    }
    network.drop(connId);
  }

  /** A peer told us its identity drive. An Admin may have a join request
   * waiting there: tell the web layer to refresh its request inbox. */
  function onPeerIdentity(keyHex: string, connId: number) {
    if (!isHexKey(keyHex)) return;
    const isNew = !peerIdentities.has(keyHex) && keyHex !== ownDrive.key;
    const c = conns.get(connId);
    if (c && keyHex !== ownDrive.key) {
      // A greeting with no version before it comes from protocol 1.
      if (c.protocol === undefined && !c.refused) c.refused = "older";
      if (c.refused) {
        if (c.refused === "older") void noteOlderPeer(connId, keyHex).catch(answerErr("version"));
        return;
      }
    }
    if (c) c.identityKey = keyHex;
    if (keyHex !== ownDrive.key) {
      void deliverAnswers(keyHex).catch(answerErr("deliver"));
      // A Join tapped while we were offline: the friend is here, finish it.
      if (
        state.folders.some(
          (f) => f.role === "creator" && (f.invited?.includes(keyHex) || f.moving?.[keyHex]),
        )
      ) {
        void acceptOfferedFriend(keyHex).catch(answerErr("acceptOffered"));
      }
      for (const seen of [...moveSeen]) if (seen.startsWith(`${keyHex}:`)) moveSeen.delete(seen);
      void deliverMoveOffers(keyHex).catch(answerErr("moveOffer"));
      void deliverOwedOffers(keyHex).catch(answerErr("owedOffer"));
      // An accepted ask whose join failed earlier: the Admin is here again.
      for (const ask of state.asks) {
        if (ask.status === "accepted" && ask.owner === keyHex) {
          void completeAccepted(ask).catch(answerErr("complete"));
        }
      }
    }
    if (!isNew) return;
    peerIdentities.add(keyHex);
    announceRequestInbox();
  }

  /** Saved state 1 → 2: every album we started moves to a new key, every other
   * album becomes read-only. Delete with rotate-album.ts once no version 1
   * state is left. A creator album that fails to move keeps its old key and is
   * retried on the next boot. */
  async function migrateFromV1(): Promise<void> {
    if (!migrating) return;
    for (const record of state.folders) {
      if (record.role === "creator") {
        if (record.rotatedAt) continue;
        try {
          const [rotateErr, rotated] = await rotateAlbum(
            {
              drives: deps.drives,
              log,
              openTimeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
            },
            {
              record,
              ownDrive,
              device: (driveKey) => deviceJson(state.name, driveKey),
              inviteCode: newInviteCode(),
              now: Date.now(),
            },
          );
          if (rotateErr) throw new Error(rotateErr.message);
          Object.assign(record, rotated);
          delete record.answers;
          delete record.declinedAsks;
          delete record.retiredInvites;
          delete record.heldAsks;
          saveState();
        } catch (e) {
          log("error", { where: "rotate.failed", folder: short(record.id), err: errText(e) });
        }
      } else if (!record.moved) {
        const ownerName = await ownerNameOf(record.shareKey);
        record.moved = true;
        record.pending = false;
        record.notice = { kind: "moved", ownerName };
        saveState();
      }
    }
    if (state.folders.every((f) => f.role !== "creator" || f.rotatedAt)) {
      migrating = false;
      saveState();
    }
  }

  async function ownerNameOf(shareKey: string): Promise<string> {
    let drive: Drive | null = null;
    try {
      const [openErr, opened] = await deps.drives.open(shareKey, { timeoutMs: 2_000 });
      if (openErr) return DEFAULT_ASK_OWNER;
      drive = opened;
      const text = await withTimeout(readText(drive, DRIVE_PATH_DEVICE), 2_000);
      return text ? peerName(parseDeviceName(text), DEFAULT_ASK_OWNER) : DEFAULT_ASK_OWNER;
    } catch {
      return DEFAULT_ASK_OWNER;
    } finally {
      try {
        if (drive) await deps.drives.release(drive);
      } catch {
        // already closed
      }
    }
  }

  async function setup(): Promise<void> {
    await deps.drives.ready();
    if (tooNew) return;
    ownDrive = await deps.drives.openOwn();
    await ensureOwnDriveIdentity();
    await migrateFromV1();

    // Registered before any topic join so early connections replicate too.
    network.start(ownDrive.key, onPeerEvent, deps.peerProtocol);
    joinTopic(topicOf(ownDrive));
    rediscover(topicOf(ownDrive), ownDrive);

    // Reopen every persisted folder so their drives stay warm.
    for (const record of state.folders) {
      // A folder this device created is persisted with role "creator"; the live
      // registry doesn't list the creator as a member, so recomputing the role
      // from it would downgrade a creator folder to "reader" (issue #42). Trust
      // the persisted creator role.
      const isCreator = record.role === "creator";
      let fd: Drive;
      if (isCreator) {
        // Our own album drive: local, so no remote-open timeout; serve its topic
        // so invitees can find it. An album created before #195 *is* the device
        // identity drive; a second Hyperdrive on the same key never becomes
        // ready, so reuse the open one.
        if (record.shareKey === ownDrive.key) {
          fd = ownDrive;
        } else {
          const [openErr, opened] = await deps.drives.open(record.shareKey, {
            timeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
          });
          if (openErr) throw openErr;
          fd = opened;
        }
        joinTopic(topicOf(fd), { server: true });
        rediscover(topicOf(fd), fd);
        if (!record.invite) {
          record.invite = { code: newInviteCode() };
          saveState();
        }
        serveInvite(record.invite.code);
        serveRetiredInvites(record);
        // People who have not followed a move, and people removed while away, still read the album's old drives.
        for (const past of record.pastKeys ?? []) {
          const [pastErr, pastDrive] = await deps.drives.open(past, {
            timeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
          });
          if (pastErr) {
            log("error", { where: "move.past", err: pastErr.message });
            continue;
          }
          joinTopic(topicOf(pastDrive), { server: true });
          rediscover(topicOf(pastDrive), pastDrive);
        }
      } else {
        fd = await openDriveWithTopic(record.shareKey, { server: false });
      }
      const selfDrive = isCreator ? fd : await openSelfDrive(record.shareKey, record.selfNs);
      const selfKey = selfDrive.key;
      const enrolled =
        !isCreator &&
        !record.moved &&
        record.notice?.kind !== "removed" &&
        isEnrolled(await readRegistryIn(fd), selfKey);
      const role: Role = isCreator ? "creator" : enrolled ? "member" : "reader";
      // A folder whose request was approved since we last ran is now a member —
      // clear the pending badge. Pending only applies to requested, un-enrolled
      // (reader) folders like the one created at join() time.
      const pending = role === "reader" && Boolean(record.pending);
      const rt: FolderRuntime = {
        record: { ...record, role, driveKey: role === "reader" ? "" : selfKey, pending },
        folderDrive: fd,
        selfDrive,
        memberDrives: new Map(),
        keptAt: new Map(),
        memberNameCache: new Map(),
        viewers: {},
        mounted: new Set(),
        watcherRemoves: new Set(),
        held: new Map(),
        heldBackfilled: false,
        former: [],
      };
      runtimes.set(record.id, rt);
      // A delete the Admin made while this phone was away, or work a restart
      // must finish: the album is removed before anything else opens.
      const deleteNote = isCreator
        ? undefined
        : await readDeleteNote(fd, { log, timeoutMs: 2_000 });
      if (deleteNote || rt.record.lifecycle === "deleting" || rt.record.lifecycle === "leaving") {
        await lifecycleOf(rt, deleteNote).settled();
        continue;
      }
      if (!isCreator) {
        void checkRemovedNote(rt, 2_000).catch((e) =>
          log("error", { where: "checkRemovedNote", folder: short(record.id), err: errText(e) }),
        );
        void refreshAlbumName(rt).catch(nameErr(rt));
      }
      if (isCreator) {
        // The swarm key changes every boot; keep this folder drive's copy current.
        try {
          await fd.put(DRIVE_PATH_DEVICE, await deviceJson(state.name, fd.key));
        } catch (e) {
          console.error(`[justus] failed to refresh creator device identity: ${errMsg(e)}`);
        }
      }
      await refreshMembersFor(rt);
      watchDrive(fd, record.id, fd.key, isCreator ? "enroll" : "add");
    }
    // An album this phone deleted is still offered to members who were away.
    for (const gone of state.gone) {
      if (gone.kind === "waitingForAdminToSeeYouLeft") {
        try {
          const self = await openSelfDrive(gone.shareKey, gone.selfNs);
          const album = await openDriveWithTopic(gone.shareKey, { server: false });
          const actor = createAlbumLifecycleActor({
            clock: RealClock(),
            port: {
              adminListsYou: async () => true,
              writeLeftNote: async () => Either.left({ reason: "Already left" }),
              writeDeleteNote: async () => Either.left({ reason: "Already left" }),
              removeCopy: async () => {},
              forget: () => forgetDrives(album, self, gone.selfNs ?? `member/${gone.shareKey}`),
            },
            start: lifecycleStart({ role: "member", saved: "waitingForAdmin" }),
          });
          lifecycles.set(gone.id, actor);
          actor.on("change", {
            fn: (snapshot) => {
              if (snapshot.path[0] === "leftAlbum") finishLeave(gone.id);
            },
          });
          watchForAdmin(gone.id, actor, album, self, gone.listedIn ?? "members");
        } catch (e) {
          log("error", { where: "gone.waiting", album: short(gone.id), err: errText(e) });
        }
        continue;
      }
      if (gone.kind !== "deletedForEveryone") continue;
      try {
        let fd: Drive;
        if (gone.shareKey === ownDrive.key) {
          fd = ownDrive;
        } else {
          const [openErr, opened] = await deps.drives.open(gone.shareKey, {
            timeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
          });
          if (openErr) throw openErr;
          fd = opened;
        }
        joinTopic(topicOf(fd), { server: true });
        rediscover(topicOf(fd), fd);
      } catch (e) {
        log("error", { where: "gone.reopen", album: short(gone.id), err: errText(e) });
      }
    }
    // Asks still waiting go back on their topic; an accepted one retries its join.
    for (const ask of state.asks) {
      if (ask.status === "waiting") {
        try {
          await openSelfDriveIn(`ask/${ask.code}`);
          await watchInvite(ask);
        } catch (e) {
          log("error", { where: "ask.resume", code: short(ask.code), err: errText(e) });
        }
      }
    }
    await pruneJoinRequests();

    // A fresh install has no albums: photos only exist inside an album the user
    // starts or joins. Dev builds start one with sample photos to look at.
    if (state.folders.length === 0) {
      if (deps.seedOnEmpty) await startFolder("Sample photos");
    } else if (state.activeFolderId === null) {
      // Restore an active pointer if the persisted one didn't survive.
      const shown = shownFolders();
      const ownFolder = shown.find((f) => f.role === "creator") ?? shown[0];
      if (ownFolder) {
        state.activeFolderId = ownFolder.id;
        saveState();
      }
    }
  }

  /** Starts a new album this device is the creator of, on a NEW single-writer
   * drive of its own, and makes it active. */
  async function startFolder(name: string): Promise<FolderRuntime> {
    const folderId = newId(deps.crypto);
    // The album gets a namespace of its own: without one, `openOwn()` is the
    // device's own identity drive.
    const [createErr, newDrive] = await createAlbumDrive(deps.drives, {
      id: folderId,
      name,
      device: (driveKey) => deviceJson(state.name, driveKey),
    });
    if (createErr) throw new Error(createErr.message);

    const rt: FolderRuntime = {
      record: {
        id: folderId,
        name,
        role: "creator",
        shareKey: newDrive.key,
        driveKey: newDrive.key,
        createdAt: Date.now(),
        invite: { code: newInviteCode() },
      },
      folderDrive: newDrive,
      selfDrive: newDrive,
      memberDrives: new Map(),
      keptAt: new Map(),
      memberNameCache: new Map(),
      viewers: {},
      mounted: new Set(),
      watcherRemoves: new Set(),
      held: new Map(),
      heldBackfilled: false,
      former: [],
    };
    runtimes.set(folderId, rt);
    state.folders.push(rt.record);
    state.activeFolderId = folderId;
    saveState();
    joinTopic(topicOf(newDrive), { server: true });
    rediscover(topicOf(newDrive), newDrive);
    serveInvite(rt.record.invite!.code);
    watchDrive(newDrive, folderId, newDrive.key, "enroll");
    if (deps.seedOnEmpty) await seedSamplePhotos(newDrive);
    return rt;
  }

  /** Drops every outbox entry that is no longer a pending request. The outbox
   * is keyed by share key and lives on the identity drive, which every holder
   * of a pre-#195 album can read (its share key *is* the identity drive key),
   * so a stale entry hands them read access to another album. */
  async function pruneJoinRequests(): Promise<void> {
    const text = await readText(ownDrive, DRIVE_PATH_REQUESTS);
    if (!text) return;
    const file = parseRequestsFile(text);
    const entries = file?.requests ?? {};
    // The live runtime knows best; an album that failed to open this boot keeps
    // its persisted pending flag rather than losing its request.
    const pending = new Set(
      state.folders
        .filter((f) => {
          const live = runtimes.get(f.id)?.record ?? f;
          return live.role === "reader" && Boolean(live.pending);
        })
        .map((f) => f.shareKey),
    );
    for (const ask of state.asks) if (ask.status === "waiting") pending.add(`invite:${ask.code}`);
    const kept = Object.fromEntries(Object.entries(entries).filter(([key]) => pending.has(key)));
    if (file && Object.keys(kept).length === Object.keys(entries).length) return;
    try {
      await ownDrive.put(
        DRIVE_PATH_REQUESTS,
        Buffer.from(JSON.stringify({ version: 1, requests: kept })),
      );
    } catch (e) {
      console.error(`[justus] failed to prune join requests: ${errMsg(e)}`);
    }
  }

  /** Files (or re-files) this device's request to be enrolled in `rt`'s album
   * with its drive for that album, on the identity drive's outbox, and serves
   * that outbox on the album's topic so the Admin (`requests()`) can read it. */
  async function fileJoinRequest(rt: FolderRuntime, folderName: string) {
    rt.record.pending = true;
    const [fileErr] = await writeJoinRequest(joinPorts, {
      identityDrive: ownDrive,
      folderDrive: rt.folderDrive,
      shareKey: rt.record.shareKey,
      requesterKey: selfKeyOf(rt),
      requesterName: state.name,
      folderName,
    });
    if (fileErr) throw new Error(fileErr.message);
  }

  // --- Private sharing: invite codes, asks and answers. ---------------------

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([p, sleep(ms).then(() => undefined)]);
  let setupDone = false;

  function answerErr(where: string) {
    return (e: unknown) => log("error", { where: `answer.${where}`, err: errText(e) });
  }

  function newInviteCode(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  function askSummary(a: AskRecord): AskSummary {
    return {
      code: a.code,
      owner: a.owner,
      albumName: a.albumName,
      ownerName: a.ownerName,
      askedAt: a.askedAt,
      status: a.status === "declined" || a.status === "linkOff" ? a.status : "waiting",
      checkCode: checkCode(ownDrive.key, crypto),
    };
  }

  /** The Admin serves an album's invite topic; a link holder meets only this device. */
  function serveInvite(code: string) {
    const topic = inviteTopic(code, crypto);
    joinTopic(topic, { server: true });
    network.findPeers(hex(topic), () => false, { drive: code });
  }

  /** A turned-off link keeps its topic (announce only), so a joiner who asked
   * through it can still be told it no longer works. */
  function serveRetiredInvites(record: FolderRecord) {
    for (const code of record.retiredInvites ?? []) {
      joinTopic(inviteTopic(code, crypto), { server: true });
    }
  }

  /** The joiner serves the same topic until its owner connects. */
  async function watchInvite(ask: AskRecord) {
    const topic = inviteTopic(ask.code, crypto);
    joinTopic(topic, { server: true });
    network.findPeers(
      hex(topic),
      () =>
        ask.status !== "waiting" || [...conns.values()].some((c) => c.identityKey === ask.owner),
      { drive: ask.code },
    );
  }

  async function fileAsk(
    code: string,
    owner: string,
    albumName: unknown,
    ownerName: unknown,
    replaces?: string,
  ): Promise<EitherResult<{ ask: AskSummary }>> {
    try {
      const drive = await openSelfDriveIn(`ask/${code}`);
      const [askErr, ask] = await fileInviteAsk(ownDrive, {
        askDriveKey: drive.key,
        code,
        owner,
        albumName,
        ownerName,
        requesterName: state.name,
        now: Date.now(),
        log,
      });
      if (askErr) return err(ErrorCode.HOST_ERROR, `Cannot send the request: ${askErr.message}`);
      const filed = replaces ? { ...ask, replaces } : ask;
      state.asks = [
        ...state.asks.filter(
          (a) =>
            a.code !== code &&
            !(a.status === "linkOff" && a.owner === owner && a.albumName === ask.albumName),
        ),
        filed,
      ];
      saveState();
      await watchInvite(filed);
      deps.onChanged({ cause: "ask", code });
      return ok({ ask: askSummary(ask) });
    } catch (e) {
      return err(ErrorCode.HOST_ERROR, `Cannot send the request: ${errMsg(e)}`);
    }
  }

  /** Records (or with `undefined` takes back) the answer to `identity`'s ask. */
  function setAnswer(
    rt: FolderRuntime,
    identity: string,
    value: "accepted" | "declined" | undefined,
  ) {
    const next: Answers = { ...rt.record.answers };
    if (value) next[identity] = value;
    else delete next[identity];
    rt.record.answers = next;
    const persisted = state.folders.find((f) => f.id === rt.record.id);
    if (persisted) persisted.answers = next;
    for (const record of persisted ? [rt.record, persisted] : [rt.record]) {
      if (record.declinedAsks) {
        const { [identity]: _dropped, ...rest } = record.declinedAsks;
        record.declinedAsks = rest;
      }
      if (record.heldAsks) {
        const { [identity]: _held, ...rest } = record.heldAsks;
        if (Object.keys(rest).length > 0) record.heldAsks = rest;
        else delete record.heldAsks;
      }
    }
    const codes = [rt.record.invite?.code, ...(rt.record.retiredInvites ?? [])].filter(
      (code): code is string => typeof code === "string",
    );
    for (const c of conns.values()) {
      if (c.identityKey === identity) forgetSent(c.sent, codes);
    }
    saveState();
  }

  /** Remembers which ask a "declined" answer closed, so a newer ask is a new request. */
  function rememberDeclinedAsk(rt: FolderRuntime, identity: string, askedAt: number) {
    const persisted = state.folders.find((f) => f.id === rt.record.id);
    for (const record of persisted ? [rt.record, persisted] : [rt.record]) {
      record.declinedAsks = { ...record.declinedAsks, [identity]: askedAt };
    }
    saveState();
  }

  const verifying = new Map<number, Promise<string | undefined>>();

  /** The identity drive key behind connection `connId`, once proven: the
   * greeting only *claims* it, so the claimed drive's `/device.json` must name
   * this connection's noise key. A restarted peer's file lags its new key, so
   * this retries for a few seconds. */
  function verifiedIdentity(connId: number): Promise<string | undefined> {
    let running = verifying.get(connId);
    if (!running) {
      running = verifyConn(connId).finally(() => verifying.delete(connId));
      verifying.set(connId, running);
    }
    return running;
  }

  async function verifyConn(connId: number): Promise<string | undefined> {
    const proven = await proveIdentity(
      (key) =>
        openPeerOutbox(key).then(
          (drive): OpenResult<Drive> => [null, drive],
          (e: unknown): OpenResult<Drive> => [e instanceof Error ? e : new Error(String(e)), null],
        ),
      {
        connId,
        conn: () => {
          const c = closed ? undefined : conns.get(connId);
          return c && { identity: c.identityKey, peerKey: c.noiseKey, verified: !!c.verified };
        },
        ownIdentity: ownDrive.key,
        attempts: 8,
        waitMs: 1_000,
        log,
      },
    );
    const c = conns.get(connId);
    if (proven && c && proven === c.identityKey) c.verified = true;
    return proven;
  }

  /** The codes `identity` asked through, read from its outbox; only when some
   * album here has turned a link off. */
  async function askedThrough(identity: string): Promise<AskedCode[]> {
    const hasRetired = [...runtimes.values()].some(
      (rt) =>
        rt.record.retiredInvites?.length ||
        (rt.record.role === "creator" && rt.record.invite?.links?.length),
    );
    if (!hasRetired) return [];
    try {
      const drive = await withTimeout(openPeerOutbox(identity), 5_000);
      if (!drive) return [];
      const text = await withTimeout(readText(drive, DRIVE_PATH_REQUESTS), 5_000);
      return text ? invitesAsked(text) : [];
    } catch (thrown: unknown) {
      log("error", { where: "answer.asked", err: errMsg(thrown) });
      return [];
    }
  }

  /** Late asks already pushed a linkOff this session, as identity:requestedAt. */
  const lateAskPushed = new Set<string>();

  /** Sends each answer owed to `identity` on every connection proven to be it. */
  async function deliverAnswers(identity: string, attempt = 0): Promise<void> {
    if (closed || !setupDone) return;
    const asked = await askedThrough(identity);
    const owed = () =>
      answersOwed(
        [...runtimes.values()].map((rt) => rt.record),
        identity,
        asked,
      );
    const { retry } = await deliverOwed(
      {
        connections: () =>
          Array.from(conns, ([conn, c]) => ({ conn, identity: c.identityKey, sent: c.sent })),
        provenIdentity: verifiedIdentity,
        sendAnswer: (conn, message) => network.sendAnswer(conn, message),
      },
      { identity, owed, log },
    );
    if (retry && attempt < 5) {
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        void deliverAnswers(identity, attempt + 1).catch(answerErr("deliver"));
      }, 1_000);
      retryTimers.add(timer);
    }
  }

  /** An answer arrived on connection `connId`. Only the owner named in the ask,
   * proven by {@link verifiedIdentity}, can settle it. */
  async function onAnswerMessage(connId: number, value: unknown): Promise<void> {
    const arrival = await arrivingAnswer(
      { provenIdentity: verifiedIdentity },
      {
        conn: connId,
        value,
        refused: !!conns.get(connId)?.refused,
        asks: () => state.asks,
      },
    );
    if (arrival.kind === "ignored") {
      if (arrival.reason !== "settled")
        log("answer.ignored", { conn: connId, reason: arrival.reason });
      return;
    }
    const ask = state.asks.find((a) => a.code === arrival.code);
    if (!ask) return;
    if (arrival.kind === "linkOff") {
      ask.status = "linkOff";
      saveState();
      leaveTopic(hex(inviteTopic(ask.code, crypto)));
      await pruneJoinRequests();
      deps.onChanged({ cause: "ask", code: ask.code, answer: "linkOff" });
      return;
    }
    if (arrival.kind === "declined") {
      ask.status = "declined";
      saveState();
      leaveTopic(hex(inviteTopic(ask.code, crypto)));
      await pruneJoinRequests();
      deps.onChanged({ cause: "ask", code: ask.code, answer: "declined" });
      return;
    }
    ask.status = "accepted";
    ask.shareKey = arrival.shareKey;
    saveState();
    await completeAccepted(ask);
  }

  /** Joins the album an accepted ask opened. A failure leaves the ask accepted:
   * the next boot, or the Admin's next connection, tries again. */
  async function completeAccepted(ask: AskRecord): Promise<void> {
    if (!ask.shareKey || !setupDone || completing.has(ask.code)) return;
    completing.add(ask.code);
    try {
      const joined = await joinAlbum(ask.shareKey, ask.albumName, {
        invite: { code: ask.code, owner: ask.owner },
        selfNs: `ask/${ask.code}`,
        replaces: ask.replaces,
      });
      if (joined[0]) {
        log("error", { where: "ask.join", code: short(ask.code), err: joined[0].message });
        return;
      }
      state.asks = state.asks.filter((a) => a.code !== ask.code);
      const heldBefore = state.offers.length;
      state.offers = state.offers.filter((o) => !(o.code === ask.code && o.owner === ask.owner));
      saveState();
      if (state.offers.length !== heldBefore) deps.onChanged({ cause: "offer" });
      leaveTopic(hex(inviteTopic(ask.code, crypto)));
      await pruneJoinRequests();
      const album = state.folders.find((f) => f.shareKey === ask.shareKey);
      deps.onChanged({ cause: "ask", code: ask.code, answer: "accepted", folderId: album?.id });
    } finally {
      completing.delete(ask.code);
    }
  }

  /** An Admin waiting for a friend's phone to answer an invite, by `identity:code`. */
  const offerWaiters = new Map<string, (reply: "seen" | "refused") => void>();
  const invitePorts: InvitePorts = {
    connections: () => Array.from(conns, ([conn, c]) => ({ conn, identity: c.identityKey })),
    provenIdentity: (conn, { timeoutMs }) => withTimeout(verifiedIdentity(conn), timeoutMs),
    sendAnswer: (conn, message) => network.sendAnswer(conn, message),
  };

  /** A friend message arrived on connection `connId`. Only a connection proven
   * to belong to an identity ({@link verifiedIdentity}) can act as that identity. */
  async function onFriendMessage(connId: number, value: unknown): Promise<void> {
    if (conns.get(connId)?.refused)
      return log("friend.ignored", { conn: connId, reason: "version" });
    const message = parseFriendMessage(value);
    if (!message) return log("friend.ignored", { conn: connId, reason: "malformed" });
    const sender = await verifiedIdentity(connId);
    if (!sender) return log("friend.ignored", { conn: connId, reason: "unverified" });
    if (message.kind === "offerSeen" || message.kind === "offerRefused") {
      const key = `${sender}:${message.code}`;
      if (message.kind === "offerSeen") moveSeen.add(key);
      settleOwed(sender, message.code, message.kind === "offerSeen");
      offerWaiters.get(key)?.(message.kind === "offerSeen" ? "seen" : "refused");
      return;
    }
    if (message.kind === "offerWithdrawn") {
      const before = state.offers.length;
      state.offers = state.offers.filter((o) => !(o.code === message.code && o.owner === sender));
      if (state.offers.length !== before) {
        saveState();
        deps.onChanged({ cause: "offer" });
      }
      return;
    }
    if (message.kind === "offerTaken") {
      void acceptOfferedFriend(sender).catch(answerErr("acceptOffered"));
      return;
    }
    if (message.kind !== "offer") return;
    receiveOffer(connId, sender, message);
  }

  /** Move offers a phone has said it saw, by `identity:code`. */
  const moveSeen = new Set<string>();

  /** Admin: after someone was removed, moves the album to new drives and
   * records who still has to follow. Returns an error text, or undefined. The
   * record changes only once every write succeeded. */
  async function moveAfterRemove(
    rt: FolderRuntime,
    options: { removedKey: string },
  ): Promise<string | undefined> {
    const { removedKey } = options;
    const record = rt.record;
    const registry = await readRegistryIn(rt.folderDrive);
    await resolveSwarmKeys().catch(() => false);
    const people = new Map<string, MovingEntry>();
    const unknownNow: MovingEntry[] = [];
    for (const m of Object.values(registry.members)) {
      const identity = presence.identities.get(m.key);
      const entry: MovingEntry = { role: "member", name: m.name, key: m.key };
      if (identity) people.set(identity, entry);
      else if (m.key !== removedKey) unknownNow.push(entry);
    }
    for (const v of Object.values(rt.viewers)) {
      const identity = presence.identities.get(v.key);
      const entry: MovingEntry = { role: "reader", name: v.name, key: v.key };
      if (identity) people.set(identity, entry);
      else if (v.key !== removedKey) unknownNow.push(entry);
    }
    const moving: Record<string, MovingEntry> = {};
    for (const [identity, m] of Object.entries(record.moving ?? {})) {
      if (m.key !== removedKey) moving[identity] = m;
    }
    for (const [identity, m] of people) moving[identity] = m;
    const unknown: Record<string, MovingEntry> = {};
    for (const m of [...Object.values(record.movingUnknown ?? {}), ...unknownNow]) {
      if (m.key === removedKey) continue;
      unknown[m.key] = m;
    }
    for (const m of Object.values(record.movingUnknown ?? {})) {
      const identity = presence.identities.get(m.key);
      if (identity && m.key !== removedKey && !moving[identity]) moving[identity] = m;
    }
    const [moveErr, moved] = await moveAlbum(
      { drives: deps.drives, log },
      {
        record,
        oldDrive: rt.folderDrive,
        remaining: { members: registry.members, viewers: rt.viewers },
        removedKey,
        device: (driveKey) => deviceJson(state.name, driveKey),
        inviteCode: newInviteCode(),
      },
    );
    if (moveErr) {
      log("error", { where: "move.failed", folder: short(record.id), err: moveErr.message });
      return moveErr.message;
    }
    const [openErr, fresh] = await deps.drives.open(moved.shareKey, {
      timeoutMs: deps.driveOpenTimeoutMs ?? 45_000,
    });
    if (openErr) return openErr.message;
    const oldInvite = record.invite?.code;
    const held: Record<string, string> = {};
    if (oldInvite) {
      const waiting = pendingJoinRequests(await readRequestsFromPeers(rt), {
        registry,
        denied: deniedRequesters,
        answers: record.answers,
        declinedAsks: record.declinedAsks,
        invited: new Set(record.invited ?? []),
        linkTimes: record.invite?.links,
        viewers: new Set(Object.keys(rt.viewers)),
      });
      const removedIdentity = presence.identities.get(removedKey);
      for (const w of waiting) {
        const identity = w.requesterIdentity;
        if (!w.viaInvite || !identity || identity === removedIdentity) continue;
        held[identity] = record.heldAsks?.[identity] ?? oldInvite;
      }
    }
    const answers: Answers = {};
    for (const [identity, answer] of Object.entries(record.answers ?? {})) {
      if (answer === "declined") answers[identity] = answer;
    }
    const patch: Partial<FolderRecord> = {
      shareKey: moved.shareKey,
      driveKey: moved.driveKey,
      pastKeys: [record.shareKey, ...(record.pastKeys ?? [])].slice(0, MAX_PAST_KEYS),
      moves: moved.moves,
      invite: moved.invite,
      retiredInvites: oldInvite
        ? [oldInvite, ...(record.retiredInvites ?? [])]
        : record.retiredInvites,
      answers,
      heldAsks: Object.keys(held).length > 0 ? held : undefined,
      moving: Object.keys(moving).length > 0 ? moving : undefined,
      movingUnknown: Object.keys(unknown).length > 0 ? unknown : undefined,
      moveOwed: undefined,
      earlier: moved.earlier,
    };
    const persisted = state.folders.find((f) => f.id === record.id);
    for (const target of persisted ? [record, persisted] : [record]) Object.assign(target, patch);
    rt.folderDrive = fresh;
    rt.selfDrive = fresh;
    rt.viewers = {};
    saveState();
    joinTopic(topicOf(fresh), { server: true });
    rediscover(topicOf(fresh), fresh);
    if (oldInvite) joinTopic(inviteTopic(oldInvite, crypto), { server: true });
    serveInvite(moved.invite.code);
    log("move.start", { folder: short(record.id), moves: moved.moves });
    if (Object.keys(unknown).length > 0) {
      log("move.unknown", { folder: short(record.id), n: Object.keys(unknown).length });
    }
    for (const identity of Object.keys(moving)) {
      void deliverMoveOffers(identity).catch(answerErr("moveOffer"));
    }
    return undefined;
  }

  /** Admin: people left out of a move whose identity is now known join `moving`.
   * Returns the identities that were added. */
  function claimUnknownMoving(): string[] {
    const claimed: string[] = [];
    for (const rt of runtimes.values()) {
      if (rt.record.role !== "creator") continue;
      const waiting = Object.values(rt.record.movingUnknown ?? {});
      const persisted = state.folders.find((f) => f.id === rt.record.id);
      for (const entry of waiting) {
        const identity = presence.identities.get(entry.key);
        if (!identity) continue;
        for (const target of persisted ? [rt.record, persisted] : [rt.record]) {
          if (!target.moving?.[identity]) target.moving = { ...target.moving, [identity]: entry };
          const { [entry.key]: _claimed, ...rest } = target.movingUnknown ?? {};
          target.movingUnknown = Object.keys(rest).length > 0 ? rest : undefined;
        }
        log("move.unknown.claimed", { folder: short(rt.record.id), identity: short(identity) });
        claimed.push(identity);
      }
    }
    if (claimed.length > 0) saveState();
    return claimed;
  }

  /** Tells `identity` the album moved, on every connection proven to be them,
   * until their phone says it saw the offer. */
  async function deliverMoveOffers(identity: string, attempt = 0): Promise<void> {
    if (closed || !setupDone) return;
    let waiting = false;
    for (const rt of Array.from(runtimes.values())) {
      const entry = rt.record.role === "creator" ? rt.record.moving?.[identity] : undefined;
      const invite = rt.record.invite;
      if (!entry || !invite || moveSeen.has(`${identity}:${invite.code}`)) continue;
      waiting = true;
      await tellIdentity(invitePorts, {
        identity,
        message: {
          kind: "offer",
          code: invite.code,
          albumName: rt.record.name,
          ownerName: state.name,
          move: { from: rt.record.pastKeys ?? [], role: entry.role },
        },
        timeoutMs: 2_000,
      });
    }
    if (waiting && attempt < 5) {
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        void deliverMoveOffers(identity, attempt + 1).catch(answerErr("moveOffer"));
      }, OFFER_RESEND_MS);
      retryTimers.add(timer);
    }
  }

  /** The friend answered an invite that was waiting: it becomes open (seen) or is dropped (refused). */
  function settleOwed(sender: string, code: string, seen: boolean) {
    let changed: string | undefined;
    for (const rt of runtimes.values()) {
      const record = rt.record;
      if (record.role !== "creator" || record.invite?.code !== code || !record.offerOwed?.[sender])
        continue;
      for (const target of [record, state.folders.find((f) => f.id === record.id)]) {
        if (!target) continue;
        target.offerOwed = dropOwed(target.offerOwed, sender);
        if (seen && !target.invited?.includes(sender)) {
          target.invited = [...(target.invited ?? []), sender];
        }
        target.invitedRoles = keepInvitedRoles(
          target.invitedRoles,
          target.invited,
          target.offerOwed,
        );
      }
      changed = record.id;
      log(seen ? "offer.owed.seen" : "offer.owed.refused", { friend: short(sender) });
    }
    if (changed === undefined) return;
    saveState();
    deps.onChanged({ cause: "offer", folderId: changed });
  }

  /** Sends the waiting friend invites to `identity` on every connection proven to be them. */
  async function deliverOwedOffers(identity: string, attempt = 0): Promise<void> {
    if (closed || !setupDone) return;
    let waiting = false;
    const now = Date.now();
    for (const rt of Array.from(runtimes.values())) {
      const { record } = rt;
      const invite = record.invite;
      if (record.role !== "creator" || record.lifecycle || !invite) continue;
      if (!liveOwed(record.offerOwed, now)[identity]) continue;
      waiting = true;
      await tellIdentity(invitePorts, {
        identity,
        message: {
          kind: "offer",
          code: invite.code,
          albumName: record.name,
          ownerName: state.name,
        },
        timeoutMs: 2_000,
      });
      log("offer.owed.sent", { friend: short(identity), n: attempt + 1 });
    }
    if (waiting && attempt < 5) {
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        void deliverOwedOffers(identity, attempt + 1).catch(answerErr("owedOffer"));
      }, OFFER_RESEND_MS);
      retryTimers.add(timer);
    }
  }

  /** Looks for `identity`'s phone on its identity topic, so a waiting invite finds it. */
  function lookFor(identity: string) {
    openPeerOutbox(identity).catch(() => undefined);
    network.findPeers(
      deps.drives.discoveryKeyOf(identity),
      () => [...conns.values()].some((c) => c.identityKey === identity && !c.refused),
      { drive: identity },
    );
  }

  /** Drops expired waiting invites and starts looking for the friends of the rest. */
  function resumeOwed() {
    const now = Date.now();
    let expired = 0;
    const friends = new Set<string>();
    for (const target of state.folders) {
      if (!target.offerOwed) continue;
      const live = liveOwed(target.offerOwed, now);
      expired += Object.keys(target.offerOwed).length - Object.keys(live).length;
      target.offerOwed = Object.keys(live).length > 0 ? live : undefined;
      target.invitedRoles = keepInvitedRoles(target.invitedRoles, target.invited, target.offerOwed);
      for (const id of Object.keys(live)) friends.add(id);
    }
    for (const rt of runtimes.values()) {
      const persisted = state.folders.find((f) => f.id === rt.record.id);
      rt.record.offerOwed = persisted?.offerOwed;
      rt.record.invitedRoles = persisted?.invitedRoles;
    }
    if (expired > 0) {
      saveState();
      log("offer.owed.expired", { n: expired });
    }
    for (const id of friends) lookFor(id);
  }

  /** Identities whose auto-accept is running, so a repeated Join tap doesn't start a second one. */
  const acceptingFriends = new Set<string>();

  /** The friend tapped Join: find their link request on their own identity drive and accept it. */
  async function acceptOfferedFriend(identity: string): Promise<void> {
    if (acceptingFriends.has(identity)) return;
    acceptingFriends.add(identity);
    try {
      for (let attempt = 0; attempt < 5 && !closed; attempt++) {
        for (const rt of Array.from(runtimes.values())) {
          const moving = rt.record.moving?.[identity];
          if (rt.record.role !== "creator" || (!rt.record.invited?.includes(identity) && !moving))
            continue;
          await openPeerOutbox(identity).catch(() => undefined);
          await withTimeout(peerOutboxDrives.get(identity)?.update() ?? Promise.resolve(), 2_000);
          const found = (await readRequestsFromPeers(rt)).find(
            (f) => f.identity === identity && f.viaInvite,
          );
          if (!found) continue;
          const [error] = await store.respond(
            rt.record.id,
            found.request.requesterKey,
            true,
            moving?.role ?? rt.record.invitedRoles?.[identity] ?? "member",
          );
          if (error && error.code !== PhotoError.ALREADY_ENROLLED) continue;
          for (const target of [rt.record, state.folders.find((f) => f.id === rt.record.id)]) {
            if (!target) continue;
            target.invited = target.invited?.filter((i) => i !== identity);
            target.invitedRoles = keepInvitedRoles(
              target.invitedRoles,
              target.invited,
              target.offerOwed,
            );
            if (target.moving) {
              const { [identity]: _arrived, ...rest } = target.moving;
              target.moving = Object.keys(rest).length > 0 ? rest : undefined;
            }
          }
          saveState();
          deps.onChanged({ cause: "offer", folderId: rt.record.id });
        }
        if (
          ![...runtimes.values()].some(
            (rt) => rt.record.invited?.includes(identity) || rt.record.moving?.[identity],
          )
        )
          return;
        await sleep(1_000);
      }
    } finally {
      acceptingFriends.delete(identity);
    }
  }

  /** Moves being followed, by invite code. */
  const following = new Set<string>();

  /** The Admin moved an album this phone is in: copy this phone's own photos
   * to a new drive, ask through the new code and join the new key as the same
   * local album. Only the album's own Admin can send this. */
  async function followMove(
    connId: number,
    sender: string,
    offer: Extract<FriendMessage, { kind: "offer" }>,
    move: NonNullable<Extract<FriendMessage, { kind: "offer" }>["move"]>,
  ): Promise<void> {
    const { code } = offer;
    const held = Array.from(runtimes.values()).filter(
      (r) => r.record.role !== "creator" && move.from.includes(r.record.shareKey),
    );
    const rt = held.find((r) => r.record.invite?.owner === sender);
    if (!rt) {
      const already = state.folders.some(
        (f) => f.invite?.code === code && f.invite.owner === sender,
      );
      if (already) {
        network.sendAnswer(connId, { kind: "offerSeen", code });
        return;
      }
      log("move.ignored", {
        sender: short(sender),
        reason: held.length > 0 ? "not-admin" : "no-album",
      });
      return;
    }
    if (state.asks.some((a) => a.code === code)) {
      network.sendAnswer(connId, { kind: "offerSeen", code });
      network.sendAnswer(connId, { kind: "offerTaken", code });
      return;
    }
    if (following.has(code)) return;
    following.add(code);
    try {
      log("move.start", { folder: short(rt.record.id), code: short(code), phase: "follow" });
      const ask = await openSelfDriveIn(`ask/${code}`);
      if (move.role === "member" && rt.record.role === "member") {
        const removed = await readRemovedIn(rt.folderDrive);
        const selfKey = selfKeyOf(rt);
        const ids = new Set<string>();
        for (const id of Object.keys(removed)) {
          if (id.startsWith(`${selfKey}:`)) ids.add(id.slice(selfKey.length + 1));
        }
        await copyOwnEntries(rt.selfDrive, ask, ids);
      }
      await copyHeld(rt.selfDrive, ask);
      const [askErr] = await fileAsk(code, sender, offer.albumName, offer.ownerName, rt.record.id);
      if (askErr) {
        log("error", { where: "followMove.ask", err: askErr.message });
        return;
      }
      network.sendAnswer(connId, { kind: "offerSeen", code });
      network.sendAnswer(connId, { kind: "offerTaken", code });
    } finally {
      following.delete(code);
    }
  }

  /** The friend side of an invite: show it, or turn it down when the sender is a stranger. */
  function receiveOffer(
    connId: number,
    sender: string,
    offer: Extract<FriendMessage, { kind: "offer" }>,
  ) {
    if (offer.move) {
      // A moved album is followed by the phones already in it, never shown as an invite.
      void followMove(connId, sender, offer, offer.move).catch((e) =>
        log("error", { where: "followMove", err: errText(e) }),
      );
      return;
    }
    const known = {
      isFriend: deps.isFriend?.(sender) ?? false,
      coMembers: new Set(presence.identities.values()),
      albumAdmins: new Set([
        ...state.folders.flatMap((f) => (f.invite?.owner ? [f.invite.owner] : [])),
        ...state.asks.map((a) => a.owner),
      ]),
    };
    if (!mayShowOfferFrom(sender, known)) {
      log("offer.refused", { sender: short(sender), code: short(offer.code) });
      network.sendAnswer(connId, { kind: "offerRefused", code: offer.code });
      return;
    }
    const alreadyIn = state.folders.some(
      (f) => f.invite?.code === offer.code && f.invite.owner === sender,
    );
    if (!alreadyIn) {
      state.offers = holdOffer(state.offers, {
        code: offer.code,
        owner: sender,
        albumName: offer.albumName,
        ownerName: offer.ownerName,
      });
      saveState();
      deps.onChanged({ cause: "offer" });
    }
    network.sendAnswer(connId, { kind: "offerSeen", code: offer.code });
  }

  function resumeAsks() {
    setupDone = true;
    for (const ask of state.asks) {
      if (ask.status === "accepted") void completeAccepted(ask).catch(answerErr("complete"));
    }
    resumeOwed();
  }

  /** Joins the album with `key`. `via` is set when the Admin accepted an ask: the
   * join then files no request (the Admin already enrolled the ask's drive) and
   * keeps the ask's drive. */
  async function joinAlbum(
    key: string,
    nameHint?: string,
    via?: { invite: { code: string; owner: string }; selfNs: string; replaces?: string },
  ): Promise<EitherResult<SyncStatus>> {
    if (!isHexKey(key)) return err(PhotoError.INVALID_KEY, "Share key must be a 64-char hex key");
    if (
      key === ownDrive.key ||
      state.folders.some((f) => f.role === "creator" && f.shareKey === key)
    )
      return err(PhotoError.INVALID_KEY, "You already own this album");

    // Idempotency (issue #47): re-joining a folder we already hold must not
    // mint a second `FolderRecord` with a fresh id — that leaves two folders
    // pointing at the same share key and double-counts it in `folders()`.
    // Reuse the existing record/runtime instead.
    const existing = state.folders.find((f) => f.shareKey === key);
    if (existing) {
      let rt = runtimes.get(existing.id);
      if (!rt) {
        // Runtime was dropped (e.g. after a restart re-setup): rebuild it from
        // the persisted record so the device's own view stays consistent.
        try {
          const fd = await openDriveWithTopic(key, { server: false });
          const selfDrive = await openSelfDrive(key, existing.selfNs);
          const selfKey = selfDrive.key;
          const enrolled = isEnrolled(await readRegistryIn(fd), selfKey);
          const role: Role = enrolled ? "member" : "reader";
          rt = {
            record: {
              ...existing,
              role,
              driveKey: role === "reader" ? "" : selfKey,
              pending: role === "reader" ? Boolean(existing.pending) : false,
            },
            folderDrive: fd,
            selfDrive,
            memberDrives: new Map(),
            keptAt: new Map(),
            memberNameCache: new Map(),
            viewers: {},
            mounted: new Set(),
            watcherRemoves: new Set(),
            held: new Map(),
            heldBackfilled: false,
            former: [],
          };
          runtimes.set(existing.id, rt);
          await refreshMembersFor(rt);
          watchDrive(fd, rt.record.id, fd.key, "add");
          // The Admin's drive may have replicated in while we joined, before the
          // watcher existed: catch up on its name now.
          void refreshAlbumName(rt).catch(nameErr(rt));
        } catch (e) {
          log("error", { where: "join.reopen", folder: short(existing.id), err: errText(e) });
          return ok(await computeStatus());
        }
      }
      // Still not enrolled: maybe the Admin approved since, else ask again.
      // A membership from before #195 was enrolled with the identity drive,
      // so it lands here and re-requests with this album's own drive.
      // A joiner who asked through an invite code never files one.
      if (rt.record.role === "reader" && !(await upgradePendingRole(rt)) && !existing.invite) {
        await fileJoinRequest(rt, rt.record.name);
        existing.pending = true;
        saveState();
        deps.onChanged({ cause: "request", folderId: rt.record.id });
      }
      return ok(await computeStatus());
    }

    // Join the folder topic first so a peer serves the drive's blocks
    // (a remote `drive.ready()` otherwise waits forever).
    const [openErr, album] = await openAlbum(joinPorts, { shareKey: key });
    if (openErr) return err(PhotoError.INVALID_KEY, `Cannot open album: ${openErr.message}`);
    const { folderDrive: drive, registry, folderName } = album;

    // The drive this device will add photos to in this album, and the key the
    // Admin enrolls (#195).
    const selfDrive = await openSelfDrive(key, via?.selfNs);
    // A note from an earlier membership must not drop this one.
    await clearLeftNote(selfDrive, { log });
    for (const waiting of state.gone.filter(
      (g) => g.kind === "waitingForAdminToSeeYouLeft" && g.shareKey === key,
    )) {
      waitingWatchers.get(waiting.id)?.();
      waitingWatchers.delete(waiting.id);
      lifecycles.delete(waiting.id);
      state.gone = state.gone.filter((g) => g !== waiting);
    }
    const selfKey = selfDrive.key;
    const enrolled = isEnrolled(registry, selfKey);
    const role: Role = enrolled ? "member" : "reader";
    // Following a move: the new album is the old one, so it keeps its local id.
    const old = via?.replaces ? runtimes.get(via.replaces) : undefined;
    const folderId = old ? old.record.id : newId(deps.crypto);
    // Photos added after the follow's first copy still sit on the old own
    // drive: copy them once more so the Admin can retire it.
    let catchUp: { from: Drive; removedIds: Set<string> } | undefined;
    if (old && old.record.role === "member" && enrolled && old.selfDrive.key !== selfDrive.key) {
      const removed = await readRemovedIn(old.folderDrive);
      const oldKey = selfKeyOf(old);
      const removedIds = new Set<string>();
      for (const id of Object.keys(removed)) {
        if (id.startsWith(`${oldKey}:`)) removedIds.add(id.slice(oldKey.length + 1));
      }
      catchUp = { from: old.selfDrive, removedIds };
    }
    if (old) await retireMovedAlbum(old);

    const rt: FolderRuntime = {
      record: {
        id: folderId,
        name: old?.record.name ?? (folderName || peerName(nameHint, JOINED_PLACEHOLDER_NAME)),
        role,
        shareKey: key,
        driveKey: enrolled ? selfKey : "",
        createdAt: old?.record.createdAt ?? Date.now(),
        ...(old?.record.lifecycle ? { lifecycle: old.record.lifecycle } : {}),
        ...(via ? { invite: via.invite, selfNs: via.selfNs } : {}),
      },
      folderDrive: drive,
      selfDrive,
      memberDrives: new Map(),
      keptAt: new Map(),
      memberNameCache: new Map(),
      viewers: {},
      mounted: new Set(),
      watcherRemoves: new Set(),
      held: new Map(),
      heldBackfilled: false,
      former: [],
    };
    runtimes.set(folderId, rt);
    if (catchUp) {
      void copyOwnEntries(catchUp.from, selfDrive, catchUp.removedIds).catch((e) =>
        log("error", { where: "move.caughtup", folder: short(folderId), err: errText(e) }),
      );
    }

    if (!enrolled) {
      // Not yet a member → file a JOIN REQUEST the creator can read. An ask
      // was answered already: the Admin enrolled its drive before sending the
      // key, so the registry watcher upgrades this reader once it replicates.
      if (!via) await fileJoinRequest(rt, folderName);

      // This device becomes a (read-only) reader of the requested folder —
      // the gallery shows it as pending until the creator approves.
      state.folders.push(rt.record);
      state.activeFolderId = folderId;
      saveState();
      await refreshMembersFor(rt);
      // Watch the folder (creator) drive so replication updates — including
      // the creator's approval that flips this device reader → member — reach
      // this store in-session (issue #52).
      watchDrive(drive, folderId, drive.key, "add");
      // The Admin's drive may have replicated in while we joined, before the
      // watcher existed: catch up on its name now.
      void refreshAlbumName(rt).catch(nameErr(rt));
      deps.onChanged({ cause: "request", folderId });
      return ok(await computeStatus());
    }

    // Already enrolled → member; make it active.
    state.folders.push(rt.record);
    state.activeFolderId = folderId;
    saveState();
    await refreshMembersFor(rt);
    watchDrive(drive, folderId, drive.key, "add");
    // The Admin's drive may have replicated in while we joined, before the
    // watcher existed: catch up on its name now.
    void refreshAlbumName(rt).catch(nameErr(rt));
    deps.onChanged({ cause: "enroll", folderId });
    return ok(await computeStatus());
  }

  const store: PhotoStore = {
    async ready() {
      if (readyPromise) return readyPromise;
      // A transient `setup()` failure (e.g. a flaky drive store or swarm) must not
      // permanently poison the store: clear the memoized promise on rejection so
      // the next `ready()` re-runs setup instead of re-throwing the same stale
      // error forever (issue #98).
      readyPromise = setup()
        .then(resumeAsks)
        .catch((e) => {
          readyPromise = null;
          throw e;
        });
      return readyPromise;
    },

    async list(opts) {
      await readyPromise;
      if (!opts?.all) {
        const rt = activeRuntime();
        return rt ? listPhotosIn(rt) : [];
      }
      const photos: Photo[] = [];
      for (const record of shownFolders()) {
        const rt = runtimes.get(record.id);
        if (rt) photos.push(...(await listPhotosIn(rt)));
      }
      return photos.sort(compareGalleryOrder);
    },

    async add(filePath, name, folderId, opts) {
      await readyPromise;
      // Thread the picker's original display name through (#99); without it the
      // stored photo would be named after the host's temp staging file rather
      // than the user's file. `addFromPath` falls back to the basename when
      // `name` is absent, so the old behaviour is preserved for nameless adds.
      const result = await addFromPath(filePath, name, folderId, opts);
      // The host staged the original and its copies for this add alone; once
      // the album holds the photo they are dead weight in the cache. A failed
      // add keeps them, so Retry can use them again.
      if (!result[0] && opts?.original) {
        for (const staged of [opts.original, filePath, opts.thumb]) {
          if (!staged || !importRoots.some((r) => isWithinRoot(path.resolve(staged), r))) continue;
          try {
            fs.unlinkSync(path.resolve(staged));
          } catch {
            // already gone
          }
        }
      }
      return result;
    },

    /** Adds a photo from bytes uploaded in-band (browser multi-file picker):
     * stages the bytes to a temp file so the path-based flow stays the single
     * source of truth, then imports it. */
    async addBytes(name, bytes, folderId) {
      await readyPromise;
      const rt = runtimeFor(folderId);
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No album is active");
      if (rt.record.role === "reader") {
        return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
      }
      const safeName =
        typeof name === "string" && name.trim() ? name.trim() : `photo-${newId(deps.crypto)}`;
      const ext = path.extname(safeName).toLowerCase().replace(/^\.$/, "");
      const staged = path.join(deps.cacheDir, `upload-${newId(deps.crypto)}${ext}`);
      try {
        fs.writeFileSync(staged, bytes as Buffer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(ErrorCode.HOST_ERROR, `Failed to stage upload: ${message}`);
      }
      try {
        // Thread the real upload filename through (#82); the staged temp file is
        // named `upload-<id>`, so without this the stored photo would be named
        // after the temp file rather than the user's file.
        return await addFromPath(staged, safeName, rt.record.id);
      } finally {
        try {
          fs.unlinkSync(staged);
        } catch {
          // already gone — nothing to clean up
        }
      }
    },

    async remove(id, folderId) {
      await readyPromise;
      const rt = runtimeFor(folderId);
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No album is active");
      const role = rt.record.role;
      const selfKey = selfKeyOf(rt);
      const selfDrive = rt.selfDrive;
      // Own photo → delete from own drive.
      for (const base of await drivePhotoKeys(selfDrive)) {
        if (base.startsWith(`${id}.`) || base === id) {
          await selfDrive.del(`${DRIVE_PATH_PHOTOS}/${base}`);
          await selfDrive.del(`${DRIVE_PATH_THUMBS}/${id}${RENDITION_EXT}`);
          forgetPhoto(rt, selfKey, id, base.slice(id.length));
          pruneIndex(id, selfKey);
          deps.onChanged({ cause: "remove", folderId: rt.record.id, memberKey: selfKey });
          return ok({ id });
        }
      }
      // Creator → tombstone another member's photo out of the derived view.
      if (role === "creator") {
        let removed = await readRemovedIn(rt.folderDrive);
        let tombstoned = false;
        for (const [key, drive] of rt.memberDrives) {
          for (const base of await drivePhotoKeys(drive)) {
            if (base.startsWith(`${id}.`) || base === id) {
              removed[`${key}:${id}`] = { memberKey: key, removedAt: Date.now() };
              forgetPhoto(rt, key, id, base.slice(id.length));
              pruneIndex(id, key);
              tombstoned = true;
            }
          }
        }
        if (tombstoned) {
          await rt.folderDrive.put(
            DRIVE_PATH_REMOVED,
            Buffer.from(JSON.stringify({ version: 1, removed })),
          );
          deps.onChanged({ cause: "remove", folderId: rt.record.id });
          return ok({ id });
        }
      }
      return err(PhotoError.NOT_FOUND, `No photo ${id}`);
    },

    async join(key, nameHint) {
      await readyPromise;
      return joinAlbum(key, nameHint);
    },

    async enroll(key, name) {
      await readyPromise;
      const rt = activeRuntime();
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No album is active");
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can enroll members");
      if (!isHexKey(key)) return err(PhotoError.INVALID_KEY, "Drive key must be a 64-char hex key");
      if (key === rt.folderDrive.key)
        return err(PhotoError.INVALID_KEY, "You cannot enroll yourself");
      const registry = await readRegistryIn(rt.folderDrive);
      if (registry.members[key]) {
        return err(PhotoError.ALREADY_ENROLLED, "Member already enrolled");
      }
      registry.members[key] = { key, name, addedAt: Date.now() };
      await rt.folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(registry)));
      await loadMemberDrive(rt, key, name);
      deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey: key });
      return ok(await computeStatus());
    },
    async status() {
      await readyPromise;
      return computeStatus();
    },

    async folders() {
      await readyPromise;
      const folders: FolderSummary[] = [];
      const archived: FolderSummary[] = [];
      for (const rt of runtimes.values()) {
        (rt.record.lifecycle === "archived" ? archived : folders).push(toSummary(rt));
      }
      const deleted: DeletedAlbum[] = state.gone.flatMap((g) =>
        g.kind === "deletedByAdmin"
          ? [{ id: g.id, name: g.name, adminName: g.adminName ?? DEFAULT_ASK_OWNER }]
          : [],
      );
      return {
        folders,
        archived,
        deleted,
        activeFolderId: activeFolderId() ?? "",
        asks: state.asks
          .filter((a) => !a.replaces)
          .filter((a) => !state.offers.some((o) => o.code === a.code && o.owner === a.owner))
          .map(askSummary),
        offers: state.offers,
      };
    },

    async ask(args) {
      await readyPromise;
      const check = checkAsk(args, state);
      if (check.kind === "invalid")
        return err(PhotoError.INVALID_KEY, "Invite code and owner must be 64-char hex keys");
      if (check.kind === "have-album")
        return err(PhotoError.ALREADY_ENROLLED, "You already have this album");
      if (check.kind === "known") return ok({ ask: askSummary(check.ask) });
      const { code, owner } = check;
      const pending = askInflight.get(code);
      if (pending) return (await pending) as EitherResult<{ ask: AskSummary }>;
      const filing = fileAsk(code, owner, args.albumName, args.ownerName);
      askInflight.set(code, filing);
      try {
        return await filing;
      } finally {
        askInflight.delete(code);
      }
    },

    async createFolder(name) {
      await readyPromise;
      if (!name || typeof name !== "string" || !name.trim()) {
        return err(PhotoError.NAME_REQUIRED, "Album name is required");
      }
      const rt = await startFolder(name.trim());
      deps.onChanged({ cause: "enroll", folderId: rt.record.id });
      return ok({ folder: toSummary(rt) });
    },

    async setActive(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      // Every album stays live (synced and mounted) so the Photos page can
      // show all of them at once; mounts and spools are per album, so nothing
      // leaks between them. Switching only changes which album status describes.
      state.activeFolderId = folderId;
      saveState();
      // Issue #86/#91/#96: switching away from this folder ran `unmountRuntime`,
      // which closed + cleared `rt.memberDrives`. If we now re-activate it, those
      // member drives must be re-opened and their update watchers re-armed —
      // otherwise peer/owner live updates stop reaching the gallery after a
      // folder round-trip. Re-sync the enrolled member set from the registry
      // (idempotent when already loaded) before arming watchers.
      await refreshMembersFor(rt);
      armFolderWatchers(rt);
      deps.onChanged({ cause: "enroll", folderId });
      return ok(await computeStatus());
    },

    async setName(name) {
      await readyPromise;
      if (!name || typeof name !== "string" || !name.trim()) {
        return err(PhotoError.NAME_REQUIRED, "Name is required");
      }
      const cleanName = name.trim();
      state.name = cleanName;
      saveState();
      await ownDrive.put(DRIVE_PATH_DEVICE, await deviceJson(cleanName));
      // Update the device.json on each drive this device writes in an album
      // (creator drives and per-album member drives) to match.
      for (const rt of runtimes.values()) {
        try {
          await rt.selfDrive.put(DRIVE_PATH_DEVICE, await deviceJson(cleanName, rt.selfDrive.key));
        } catch (e) {
          const message = errMsg(e);
          console.error(`[justus] failed to update device name: ${message}`);
        }
      }
      deps.onChanged({ cause: "enroll", folderId: activeFolderId() ?? undefined });
      return ok({ name: cleanName });
    },

    async requests() {
      await readyPromise;
      const out: JoinRequest[] = [];
      for (const rt of runtimes.values()) {
        if (rt.record.role !== "creator") continue;
        // Enrolled, denied and answered invite requests are not pending (#84, #85).
        const registry = await readRegistryIn(rt.folderDrive);
        const found = await readRequestsFromPeers(rt);
        for (const f of found) {
          const key = `${f.identity}:${f.request.requestedAt}`;
          if (
            f.viaInvite &&
            !f.held &&
            !lateAskPushed.has(key) &&
            !rt.record.invited?.includes(f.identity) &&
            !inLinkTime(rt.record.invite?.links, f.request.requestedAt)
          ) {
            lateAskPushed.add(key);
            void deliverAnswers(f.identity).catch(answerErr("deliver"));
          }
        }
        out.push(
          ...pendingJoinRequests(found, {
            registry,
            denied: deniedRequesters,
            answers: rt.record.answers,
            declinedAsks: rt.record.declinedAsks,
            invited: new Set(rt.record.invited ?? []),
            linkTimes: rt.record.invite?.links,
            viewers: new Set(Object.keys(rt.viewers)),
            checkCodeOf: (id) => checkCode(id, crypto),
          }),
        );
      }
      return { requests: out };
    },

    async respond(folderId, requesterKey, approve, role = "member") {
      await readyPromise;
      if (role !== "reader" && role !== "member")
        return err(PhotoError.INVALID_ROLE, "Role must be reader or member");
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can respond to requests");
      if (!isHexKey(requesterKey))
        return err(PhotoError.INVALID_KEY, "Requester key must be a 64-char hex key");
      requesterKey = requesterKey.toLowerCase();
      if (!requesterIdentity.has(requesterKey)) await readRequestsFromPeers(rt);
      const identity = requesterIdentity.get(requesterKey);
      const askedBy =
        identity && rt.record.invite && inviteRequesters.has(requesterKey) ? identity : undefined;
      const registry = await readRegistryIn(rt.folderDrive);
      const reply = replyTo(
        { askedBy, enrolled: Boolean(registry.members[requesterKey]) },
        { approve },
      );
      if (reply.kind === "decline-ask") {
        // The joiner is told; a newer ask from them is a new request.
        const asked = (await readRequestsFromPeers(rt)).find(
          (f) => f.request.requesterKey === requesterKey && f.viaInvite,
        );
        setAnswer(rt, reply.identity, "declined");
        if (asked) rememberDeclinedAsk(rt, reply.identity, asked.request.requestedAt);
        deps.onChanged({ cause: "request", folderId });
        void deliverAnswers(reply.identity).catch(answerErr("deliver"));
        return ok({ ok: true });
      }
      if (reply.kind === "decline") {
        // Denials have no state to write — the request just stays on the
        // requester's own drive until it is superseded. Remember it for the
        // session so a re-filed request doesn't resurface as pending (#85).
        deniedRequesters.add(requesterKey);
        deps.onChanged({ cause: "request", folderId });
        return ok({ ok: true });
      }
      if (reply.kind === "already-enrolled" || rt.viewers[requesterKey]) {
        return err(PhotoError.ALREADY_ENROLLED, "Member already enrolled");
      }
      // The requester's own reported name comes from its `/requests.json`;
      // acceptJoinRequest falls back to a neutral label.
      const found = await readRequestsFromPeers(rt);
      if (role === "reader") {
        if (reply.kind !== "accept" || !reply.identity) {
          return err(
            PhotoError.VIEWER_NEEDS_INVITE,
            "Only someone who asked through an invite link can join as a Viewer",
          );
        }
        // Same order as a Collaborator: the answer is recorded first and taken
        // back if the seat cannot be written. A Viewer's drive is read only for its
        // /device.json (who is connected); their photos never are.
        const asker = reply.identity;
        setAnswer(rt, asker, "accepted");
        const [seatErr, seated] = await seatViewer(rt.folderDrive, {
          viewers: { version: 1, viewers: rt.viewers },
          registry,
          requesterKey,
          requests: found.map((f) => f.request),
        });
        if (seatErr) {
          setAnswer(rt, asker, undefined);
          if (seatErr.kind === "already-enrolled")
            return err(PhotoError.ALREADY_ENROLLED, seatErr.message);
          return err(ErrorCode.HOST_ERROR, `Cannot add the Viewer: ${seatErr.message}`);
        }
        rt.viewers = seated.viewers.viewers;
        await forgetFormer(rt, asker);
        deps.onChanged({ cause: "enroll", folderId, memberKey: requesterKey });
        void deliverAnswers(asker).catch(answerErr("deliver"));
        return ok({ ok: true });
      }
      // The answer is recorded before the key can leave: if the registry write
      // fails the answer is taken back, so no one holds a key without a seat.
      const seated = reply.kind === "accept" ? reply.identity : undefined;
      if (seated) setAnswer(rt, seated, "accepted");
      const [acceptErr, accepted] = await acceptJoinRequest(rt.folderDrive, {
        registry,
        requesterKey,
        requests: found.map((f) => f.request),
      });
      if (acceptErr) {
        if (seated) setAnswer(rt, seated, undefined);
        if (acceptErr.kind === "already-enrolled")
          return err(PhotoError.ALREADY_ENROLLED, acceptErr.message);
        return err(ErrorCode.HOST_ERROR, `Cannot enroll the member: ${acceptErr.message}`);
      }
      await loadMemberDrive(rt, requesterKey, accepted.member.name);
      const joined = rt.memberDrives.get(requesterKey);
      await forgetFormer(
        rt,
        seated ??
          requesterIdentity.get(requesterKey) ??
          (joined ? await identityOfDrive(joined) : undefined),
      );
      deps.onChanged({ cause: "enroll", folderId, memberKey: requesterKey });
      if (seated) void deliverAnswers(seated).catch(answerErr("deliver"));
      return ok({ ok: true });
    },

    async turnOffInvite(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can turn off invite links");
      const next = await withdrawInvite(invitePorts, {
        album: rt.record,
        newCode: newInviteCode(),
      });
      rt.record.invited = undefined;
      rt.record.offerOwed = undefined;
      rt.record.invitedRoles = undefined;
      rt.record.invite = next.invite;
      if (next.retired) rt.record.retiredInvites = next.retiredInvites;
      const persisted = state.folders.find((f) => f.id === folderId);
      if (persisted) {
        persisted.invite = next.invite;
        persisted.invited = undefined;
        persisted.offerOwed = undefined;
        persisted.invitedRoles = undefined;
        persisted.retiredInvites = rt.record.retiredInvites;
      }
      saveState();
      serveInvite(next.invite.code);
      deps.onChanged({ cause: "request", folderId });
      const connected = new Set<string>();
      for (const c of conns.values()) {
        if (c.identityKey && !c.refused && c.identityKey !== ownDrive.key) {
          connected.add(c.identityKey);
        }
      }
      for (const id of connected) void deliverAnswers(id).catch(answerErr("deliver"));
      return ok({ invite: { code: next.invite.code, owner: ownDrive.key } });
    },

    async saveInviteLink(folderId, expiresAt) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator" || !rt.record.invite)
        return err(PhotoError.NOT_CREATOR, "Only the creator can make invite links");
      const now = Date.now();
      if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_LINK_MS) {
        return err(PhotoError.INVALID_LINK_TIME, "Link end time must be in the next 7 days");
      }
      const known = rt.record.invite.links ?? [];
      if (known.some((l) => l.to === expiresAt)) return ok({ ok: true });
      const links = [...known, { from: now, to: expiresAt }].slice(-MAX_LINK_TIMES);
      rt.record.invite = { ...rt.record.invite, links };
      const persisted = state.folders.find((f) => f.id === folderId);
      if (persisted?.invite) persisted.invite = { ...persisted.invite, links };
      saveState();
      return ok({ ok: true });
    },

    async offerAlbum(folderId, identity, role = "member") {
      if (role !== "reader" && role !== "member")
        return err(PhotoError.INVALID_ROLE, "Role must be reader or member");
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can invite a friend");
      if (!isHexKey(identity) || identity === ownDrive.key)
        return err(PhotoError.INVALID_KEY, "Friend key must be a 64-char hex key");
      const invite = rt.record.invite;
      if (!invite) return err(PhotoError.FOLDER_NOT_FOUND, `No invite for album ${folderId}`);
      openPeerOutbox(identity).catch((e) =>
        log("error", { where: "offerAlbum.open", err: errText(e) }),
      );
      const key = `${identity}:${invite.code}`;
      if (offerWaiters.has(key))
        return err(PhotoError.OFFER_PENDING, "This invite is already waiting for that friend");
      const reply = new Promise<"seen" | "refused">((resolve) => offerWaiters.set(key, resolve));
      try {
        const [offerErr] = await offerAlbumTo(invitePorts, {
          identity,
          offer: { code: invite.code, albumName: rt.record.name, ownerName: state.name },
          reply,
          reachMs: deps.offerReachMs ?? OFFER_REACH_MS,
          resendMs: OFFER_RESEND_MS,
          isClosed: () => closed,
        });
        if (offerErr?.kind === "refused") return err(PhotoError.FRIEND_REFUSED, offerErr.message);
        if (offerErr?.kind === "unreachable") {
          const now = Date.now();
          for (const target of [rt.record, state.folders.find((f) => f.id === folderId)]) {
            if (!target) continue;
            target.offerOwed = holdOwed(target.offerOwed, identity, now);
            target.invitedRoles = { ...target.invitedRoles, [identity]: role };
          }
          saveState();
          log("offer.owed", { friend: short(identity), folder: short(folderId) });
          lookFor(identity);
          deps.onChanged({ cause: "offer", folderId });
          return ok({ ok: true, waiting: true });
        }
        if (offerErr) return err(PhotoError.FRIEND_UNREACHABLE, offerErr.message);
        for (const target of [rt.record, state.folders.find((f) => f.id === folderId)]) {
          if (!target) continue;
          target.offerOwed = dropOwed(target.offerOwed, identity);
          if (!target.invited?.includes(identity)) {
            target.invited = [...(target.invited ?? []), identity];
          }
          target.invitedRoles = { ...target.invitedRoles, [identity]: role };
        }
        saveState();
        deps.onChanged({ cause: "offer", folderId });
        return ok({ ok: true });
      } finally {
        offerWaiters.delete(key);
      }
    },

    async joinOffer(code, owner) {
      await readyPromise;
      const take = offerToTake(state, { code, owner });
      if (take.kind === "gone") return err(PhotoError.OFFER_GONE, "This invite was taken back");
      let summary: AskSummary;
      if (take.kind === "file-ask") {
        const filed = await fileAsk(code, owner, take.offer.albumName, take.offer.ownerName);
        if (filed[0]) return filed;
        summary = filed[1].ask;
      } else {
        summary = askSummary(take.ask);
      }
      await tellIdentity(invitePorts, {
        identity: owner,
        message: { kind: "offerTaken", code },
        timeoutMs: 2_000,
      });
      return ok({ ask: summary });
    },

    async makeMember(folderId, memberKey) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the Admin can let a Viewer add photos");
      if (!isHexKey(memberKey) || memberKey.toLowerCase() === rt.record.shareKey.toLowerCase())
        return err(PhotoError.INVALID_KEY, "Member key must be a 64-char hex key");
      const key = memberKey.toLowerCase();
      await refreshViewers(rt);
      const registry = await readRegistryIn(rt.folderDrive);
      const [upErr, upgraded] = await makeViewerMember(rt.folderDrive, {
        viewers: { version: 1, viewers: rt.viewers },
        registry,
        memberKey: key,
      });
      if (upErr) {
        if (upErr.kind === "no-such-viewer") return err(PhotoError.NOT_FOUND, "No such Viewer");
        if (upErr.kind === "already-enrolled")
          return err(PhotoError.ALREADY_ENROLLED, upErr.message);
        return err(ErrorCode.HOST_ERROR, `Cannot let the Viewer add photos: ${upErr.message}`);
      }
      await refreshMembersFor(rt);
      deps.onChanged({ cause: "enroll", folderId, memberKey: key });
      return ok({ ok: true });
    },

    async makeViewer(folderId, memberKey) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the Admin can make someone a Viewer");
      if (!isHexKey(memberKey) || memberKey.toLowerCase() === rt.record.shareKey.toLowerCase())
        return err(PhotoError.INVALID_KEY, "Member key must be a 64-char hex key");
      const key = memberKey.toLowerCase();
      await refreshViewers(rt);
      const registry = await readRegistryIn(rt.folderDrive);
      if (!registry.members[key] && !rt.viewers[key])
        return err(PhotoError.NOT_FOUND, "No such Collaborator");
      const drive = rt.memberDrives.get(key) ?? (await openDriveWithTopic(key, { server: false }));
      // Pick up what the person has added that has reached this phone.
      await Promise.race([
        drive.update().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      const [viewerErr] = await makeMemberViewer(rt.folderDrive, {
        viewers: { version: 1, viewers: rt.viewers },
        registry,
        memberKey: key,
        keptVersion: drive.version(),
      });
      if (viewerErr) {
        if (viewerErr.kind === "no-such-member")
          return err(PhotoError.NOT_FOUND, "No such Collaborator");
        return err(ErrorCode.HOST_ERROR, `Cannot make them a Viewer: ${viewerErr.message}`);
      }
      await refreshMembersFor(rt);
      armFolderWatchers(rt);
      deps.onChanged({ cause: "enroll", folderId, memberKey: key });
      return ok({ ok: true });
    },

    async removeMember(folderId, memberKey) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the Admin can remove a member");
      if (!isHexKey(memberKey))
        return err(PhotoError.INVALID_KEY, "Member key must be a 64-char hex key");
      memberKey = memberKey.toLowerCase();
      if (memberKey === selfKeyOf(rt) || memberKey === ownDrive.key)
        return err(PhotoError.INVALID_KEY, "You cannot remove yourself");
      await refreshViewers(rt);
      const registry = await readRegistryIn(rt.folderDrive);
      const stillMoving = Object.entries(rt.record.moving ?? {}).find(
        ([, m]) => m.key === memberKey,
      );
      const stillUnknown = Object.values(rt.record.movingUnknown ?? {}).some(
        (m) => m.key === memberKey,
      );
      const isMember = Boolean(registry.members[memberKey]);
      const isViewer = Boolean(rt.viewers[memberKey]);
      const owed = (rt.record.moveOwed ?? []).includes(memberKey);
      if (!isMember && !isViewer && !stillMoving && !stillUnknown && !owed)
        return err(PhotoError.NOT_FOUND, "No such member");
      // Mark the move as owed before the removal, so a failed move can be retried.
      if (isMember || isViewer) {
        const persisted = state.folders.find((f) => f.id === rt.record.id);
        for (const target of persisted ? [rt.record, persisted] : [rt.record]) {
          target.moveOwed = [memberKey, ...(target.moveOwed ?? []).filter((k) => k !== memberKey)];
        }
        saveState();
      }
      const clearOwed = () => {
        const persisted = state.folders.find((f) => f.id === rt.record.id);
        for (const target of persisted ? [rt.record, persisted] : [rt.record]) {
          target.moveOwed = target.moveOwed?.filter((k) => k !== memberKey);
          if (!target.moveOwed?.length) delete target.moveOwed;
        }
        saveState();
      };
      const leaving = await formerSnapshot(rt, memberKey);
      // Today's removal first, on the old drive: the removed phone sees itself removed.
      if (isMember) {
        const [removeErr] = await removeAlbumMember(rt.folderDrive, { memberKey, log });
        if (removeErr?.kind === "no-such-member") {
          clearOwed();
          return err(PhotoError.NOT_FOUND, "No such member");
        }
        if (removeErr) {
          clearOwed();
          throw new Error(removeErr.message);
        }
      } else if (isViewer) {
        const { [memberKey]: _gone, ...left } = rt.viewers;
        try {
          await rt.folderDrive.put(
            DRIVE_PATH_VIEWERS,
            Buffer.from(JSON.stringify({ version: 1, viewers: left })),
          );
        } catch (e) {
          clearOwed();
          return err(ErrorCode.HOST_ERROR, `Cannot remove: ${errText(e)}`);
        }
        rt.viewers = left;
      }
      if (isMember || isViewer || owed) {
        const [noteErr] = await addRemovedPerson(rt.folderDrive, { key: memberKey, log });
        if (noteErr) return err(ErrorCode.HOST_ERROR, `Cannot remove: ${noteErr.reason}`);
        const gone = rt.memberDrives.get(memberKey) ?? viewerDeviceDrives.get(memberKey)?.drive;
        await noteFormer(rt, leaving, gone ? await identityOfDrive(gone) : undefined);
      }
      // Stop loading their drive; a re-filed request must not resurface at once.
      deniedRequesters.add(memberKey);
      const moved = await moveAfterRemove(rt, { removedKey: memberKey });
      if (moved) return err(ErrorCode.HOST_ERROR, `Cannot remove: ${moved}`);
      await refreshMembersFor(rt);
      armFolderWatchers(rt);
      deps.onChanged({ cause: "enroll", folderId, memberKey });
      return ok({ ok: true });
    },

    async archiveAlbum(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.lifecycle === "archived") return ok({ ok: true });
      return changeLifecycle(rt, "archive");
    },

    async restoreAlbum(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.lifecycle !== "archived") return ok({ ok: true });
      return changeLifecycle(rt, "restore");
    },

    async deleteAlbum(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role !== "creator") {
        return err(PhotoError.NOT_CREATOR, "Only the Admin can delete an album");
      }
      if (rt.record.lifecycle === "archived") {
        return err(PhotoError.ALBUM_ARCHIVED, "Restore the album before deleting it");
      }
      return changeLifecycle(rt, "deleteForEveryone");
    },

    async leaveAlbum(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No album ${folderId}`);
      if (rt.record.role === "creator") {
        return err(
          PhotoError.ADMIN_CANNOT_LEAVE,
          "The Admin cannot leave; delete the album instead",
        );
      }
      if (rt.record.lifecycle === "archived") {
        return err(PhotoError.ALBUM_ARCHIVED, "Restore the album before leaving it");
      }
      return changeLifecycle(rt, "leave");
    },

    async dismissAlbumNotice(folderId) {
      await readyPromise;
      const found = state.gone.find((g) => g.id === folderId && g.kind === "deletedByAdmin");
      if (!found) return err(PhotoError.FOLDER_NOT_FOUND, `No notice for ${folderId}`);
      state.gone = state.gone.filter((g) => g !== found);
      saveState();
      deps.onChanged({ cause: "remove", folderId });
      return ok({ ok: true });
    },

    async dismissDeclinedAsk(code) {
      await readyPromise;
      const found = state.asks.find((a) => a.code === code && a.status === "declined");
      if (!found) return err(PhotoError.NOT_FOUND, `No declined request for ${code}`);
      state.asks = state.asks.filter((a) => a !== found);
      saveState();
      deps.onChanged({ cause: "ask", code });
      return ok({ ok: true });
    },

    async cancelAsk(code) {
      await readyPromise;
      const found = state.asks.find(
        (a) => a.code === code && (a.status === "waiting" || a.status === "linkOff"),
      );
      if (!found) return err(PhotoError.NOT_FOUND, `No open request for ${code}`);
      state.asks = state.asks.filter((a) => a !== found);
      saveState();
      leaveTopic(hex(inviteTopic(code, crypto)));
      await pruneJoinRequests();
      deps.onChanged({ cause: "ask", code });
      return ok({ ok: true });
    },

    debugState() {
      const driveInfo = (drive: Drive) => ({
        key: drive.key,
        ...drive.stats(),
      });
      return {
        now: Date.now(),
        ...network.debug(),
        swarmKey: ownSwarmKey() ?? null,
        identityDrive: ownDrive ? ownDrive.key : null,
        connections: [...conns].map(([conn, c]) => ({
          conn,
          noiseKey: c.noiseKey ?? null,
          identityKey: c.identityKey ?? null,
          initiator: c.initiator ?? null,
          openedAt: c.openedAt,
        })),
        peerIdentities: [...peerIdentities],
        gone: state.gone.map((g) => ({
          id: g.id,
          kind: g.kind,
          shareKey: g.shareKey,
          ...(g.listedIn ? { listedIn: g.listedIn } : {}),
        })),
        indexedPhotos: [...contentIndex.values()].reduce((n, arr) => n + arr.length, 0),
        asks: state.asks.map((a) => ({ code: a.code, owner: a.owner, status: a.status })),
        remoteDrives: [
          ...[...peerOutboxDrives].map(([key, d]) => ({
            role: "peer-outbox",
            ...driveInfo(d),
            key,
          })),
          ...[...runtimes.values()].flatMap((rt) =>
            [...rt.memberDrives.values()].map((d) => ({
              role: "member",
              folder: rt.record.id,
              ...driveInfo(d),
            })),
          ),
        ],
        folders: [...runtimes.values()].map((rt) => ({
          id: rt.record.id,
          role: rt.record.role,
          lifecycle: rt.record.lifecycle ?? "shown",
          pending: Boolean(rt.record.pending),
          invited: rt.record.invited ?? [],
          offerOwed: rt.record.offerOwed ?? {},
          invitedRoles: rt.record.invitedRoles ?? {},
          answers: rt.record.answers ?? {},
          shareKey: rt.record.shareKey,
          folderDrive: driveInfo(rt.folderDrive),
          selfDrive: driveInfo(rt.selfDrive),
          members: [...rt.memberDrives.keys()].map((key) => ({
            key,
            swarmKey: presence.peerKeys.get(key) ?? null,
            connected: memberPresence(presence, key).connected,
          })),
          folderOwner: {
            swarmKey: presence.peerKeys.get(rt.record.shareKey) ?? null,
            connected: memberPresence(presence, rt.record.shareKey).connected,
          },
        })),
      };
    },

    async close() {
      closed = true;
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      // Tear down every folder: drop update watchers, unmount loopback routes,
      // and remove the per-folder spool dir so a shutdown leaves no mounts or
      // stale cache behind (#101).
      for (const rt of runtimes.values()) {
        await unmountRuntime(rt);
      }
      for (const { drive, off } of viewerDeviceDrives.values()) {
        off();
        await deps.drives.release(drive).catch(() => {});
      }
      viewerDeviceDrives.clear();
      try {
        await network.close();
      } catch {
        // already closed
      }
      try {
        await deps.drives.close();
      } catch {
        // already closed
      }
    },
  };

  return tooNew ? updateRequiredStore(store) : store;
}

const UPDATE_REQUIRED_TEXT = "Update Justus to open your albums.";

/** What a newer Justus left behind cannot be read here: every call says so and
 * nothing is read or written. */
function updateRequiredStore(inner: PhotoStore): PhotoStore {
  const refuse = (): Promise<EitherResult<never>> =>
    Promise.resolve(err(PhotoError.UPDATE_REQUIRED, UPDATE_REQUIRED_TEXT));
  const fail = (): Promise<never> => Promise.reject(new Error(UPDATE_REQUIRED_TEXT));
  return {
    ready: () => inner.ready(),
    list: fail,
    add: refuse,
    addBytes: refuse,
    remove: refuse,
    join: refuse,
    enroll: refuse,
    status: fail,
    folders: fail,
    ask: refuse,
    createFolder: refuse,
    setActive: refuse,
    setName: refuse,
    requests: fail,
    makeMember: refuse,
    makeViewer: refuse,
    removeMember: refuse,
    respond: refuse,
    turnOffInvite: refuse,
    saveInviteLink: refuse,
    offerAlbum: refuse,
    joinOffer: refuse,
    archiveAlbum: refuse,
    restoreAlbum: refuse,
    deleteAlbum: refuse,
    leaveAlbum: refuse,
    dismissAlbumNotice: refuse,
    dismissDeclinedAsk: refuse,
    cancelAsk: refuse,
    debugState: () => inner.debugState(),
    close: () => inner.close(),
  };
}

// Seed data: real generated JPEGs (480x320 gradients), dev only.
const SAMPLE_1 = base64ToBytes(
  "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",
);
const SAMPLE_2 = base64ToBytes(
  "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",
);
const SAMPLE_3 = base64ToBytes(
  "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",
);
