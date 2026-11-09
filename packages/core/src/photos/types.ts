export type Role = "creator" | "member" | "reader";

/** Provenance of a photo: the member drive it lives in + the device name from
 * that drive's `/device.json`. */
export type PhotoMember = {
  key: string;
  name: string;
};

/** Who has a full copy of a photo, as their phones last told this one. */
export type PhotoHolders = {
  /** This phone has the full copy (it added the photo, or the copy finished arriving). */
  here: boolean;
  /** Current album people other than this phone with a full copy, the adder always included. Sorted by name, then key. */
  others: PhotoMember[];
  /** Current album people (not this phone, not in `others`) whose phone has not said what it holds. Sorted like `others`. */
  unsure: PhotoMember[];
  /** Current album people (not this phone, not the adder) whose phone said what it holds, without this photo. Sorted like `others`. */
  waiting: PhotoMember[];
  /** Names of people the Admin removed who had a copy when they went; they keep it. Sorted, unique. */
  former: string[];
  /** Names of people who left the album and had a copy when they went; their phone deleted it, so they are not holders. Sorted, unique. */
  left: string[];
};

export type Photo = {
  /** File id within the member drive (e.g. `abc123`). */
  id: string;
  /** Loopback-served URL of the display copy (same-origin, cookie-gated on
   * device). Its bytes are fetched from the member only when it is loaded. */
  url: string;
  /** Loopback-served URL of the thumbnail. Unset for photos added before
   * thumbnails existed: show `url` instead. */
  thumbUrl?: string;
  /** File name, with the extension of the shared copy. */
  name: string;
  mime: string;
  size: number;
  /** When it was added to Justus (ms epoch) — the "date added" timeline. */
  addedAt: number;
  /** When it was taken, from the photo's EXIF: camera wall-clock time
   * `YYYY-MM-DDTHH:MM:SS`, plus `±HH:MM` when the camera recorded its offset.
   * Unset when the file carries no capture date. */
  takenAt?: string;
  member: PhotoMember;
  /** sha256 of the original bytes on the adding device (ingest dedupe).
   * Optional: entries stored before this field existed don't carry it. */
  sha256?: string;
  /** The folder (album) this photo belongs to. Set by every list, so a
   * cross-album list can be filtered and acted on per album. */
  folderId?: string;
  /** True when this device added the photo (it lives on our own drive). */
  mine?: boolean;
  /** Unset when this phone cannot tell yet. */
  holders?: PhotoHolders;
};

export type SyncMember = {
  key: string;
  name: string;
  /** True for the album's Admin (the creator of the folder). */
  admin: boolean;
  /** True when this device can reach the member right now. This device always
   * counts as connected to itself. */
  connected: boolean;
  /** Last time the member was reachable (ms epoch); unset if never seen. */
  lastSeenAt?: number;
  /** The member's identity drive key: the same in every album. Unset until their
   * `/device.json` names it (older apps never do). */
  identity?: string;
  /** Accepted as a Viewer: sees every photo, adds none. Unset for the Admin and Collaborators. */
  viewer?: boolean;
};

/** A call A device's view of one folder it belongs to. A device can hold many
 * folders; exactly one is active (the gallery shows it). */
/** Why an album needs a word from the user after the key move. */
export type FolderNotice = { kind: "newKey" | "moved" | "removed"; ownerName?: string };

export type FolderSummary = {
  /** Local id of the folder on this device (stable across sessions). */
  id: string;
  /** User-given name; creators set it at creation, joiners see the name the
   * creator set once the folder's registry is read. */
  name: string;
  /** This device's role in the folder. */
  role: Role;
  /** True while this device's writer enrollment is awaiting the creator's
   * approval (a requested join). The device can read by share key regardless. */
  pending?: boolean;
  /** The folder's share key — the creator drive's key (hex). */
  shareKey: string;
  /** This device's drive key (hex). Empty for readers. */
  driveKey: string;
  /** Member count as known from the registry (creator + writers). */
  members: number;
  /** When this device joined/created the folder (ms epoch). */
  addedAt: number;
  /** The invite code: the creator's own, or the one a joiner asked through. */
  invite?: { code: string; owner: string };
  /** Set on an album that moved to a new key. */
  notice?: FolderNotice;
  /** Admin only: identity keys of friends whose invite is waiting for them to open Justus, oldest first. */
  waitingFor?: string[];
  /** Admin only: friends invited to this album who have not joined; the ones whose phone has not taken the invite yet come first. */
  invitedFriends?: InvitedFriend[];
};

/** A friend the Admin invited who has not joined yet. */
export type InvitedFriend = {
  /** The friend's identity key (the key they are saved under in friends). */
  identity: string;
  /** What they become when they join. */
  role: "reader" | "member";
};

/** An album its Admin deleted for everyone. The phone removed the album and its
 * photos; this notice stays until the person dismisses it. */
export type DeletedAlbum = {
  /** The id the album had on this phone. */
  id: string;
  name: string;
  /** The Admin's name, as the phone last knew it. */
  adminName: string;
};

/** A request to join an album, made through an invite code and not yet
 * answered with the key (waiting) or answered no (declined). */
export type AskSummary = {
  code: string;
  /** The Admin's identity drive key (hex). */
  owner: string;
  albumName: string;
  ownerName: string;
  /** When this device asked (ms epoch). */
  askedAt: number;
  /** "linkOff": the Admin's phone said this link no longer works. */
  status: "waiting" | "declined" | "linkOff";
  /** This phone's check code, shown while it waits. */
  checkCode?: string;
  /** Set while this phone has met the Admin's phone on a newer Justus this session: this phone must update. */
  whoMustUpdate?: "you";
};

/** An album invite a friend sent straight to this phone, not answered yet.
 * `code` is the album's invite code and `owner` the Admin's identity key. */
export type OfferSummary = {
  code: string;
  owner: string;
  albumName: string;
  ownerName: string;
};

/** This device's read view over the folder it is currently showing. */
export type SyncStatus = {
  /** The active folder this status describes. */
  folder: FolderSummary;
  /** This device's user name (persisted in `/device.json`). */
  name: string;
  /** This device's drive key (hex). Empty for readers. */
  driveKey: string;
  /** This device's drive discovery topic (hex). */
  discoveryKey: string;
  peers: number;
  photos: number;
  members: SyncMember[];
  /** A phone on a newer Justus refused to sync with this one. */
  updateNeeded: boolean;
  /** Names of phones on an older Justus that this one refused. */
  peersBehind: string[];
};

/** Pending "wants to join" request surfaced to a folder's creator. */
export type JoinRequest = {
  /** The requester's drive key (hex). */
  requesterKey: string;
  /** The requester's user name (read from its `/device.json`). */
  requesterName: string;
  /** The folder this request targets. */
  folderId: string;
  /** The folder's name, for the "<name> wants to join <folder>" copy. */
  folderName: string;
  /** Share key of the folder being requested. */
  shareKey: string;
  /** When the request was first seen (ms epoch). */
  requestedAt: number;
  /** Asked through this album's invite link, so it can be accepted as a Viewer. */
  viaInvite?: boolean;
  /** The asker's check code, the same one their phone shows. */
  checkCode?: string;
  /** The asker's identity key, the one saved friends are stored under. */
  requesterIdentity?: string;
};

export type PhotoChangedCause =
  | "add"
  | "remove"
  | "enroll"
  | "request"
  | "presence"
  | "ask"
  | "offer"
  | "version"
  | "holders"
  | "role";

/** A role this phone can be moved between by the Admin. The Admin's own role never changes. */
export type ChangedRole = "member" | "reader";

/** For cause "role": the Admin changed this phone's role in an album while it was running. */
export type RoleChange = {
  from: ChangedRole;
  to: ChangedRole;
  /** The album's name on this phone. */
  albumName: string;
  /** The Admin's name from their phone; unset when it is not known. */
  adminName?: string;
};

/** Backend → web push payload for the `photos.changed` dispatch. */
export type PhotoChanged = {
  cause: PhotoChangedCause;
  /** The folder this change concerns; `undefined` while not multi-folder
   * aware (older peers). The web layer keys animation/refresh off it. */
  folderId?: string;
  memberKey?: string;
  /** For cause "ask": the invite code asked through, and the Admin's answer. */
  code?: string;
  /** "linkOff": the Admin turned this link off before answering. */
  answer?: "accepted" | "declined" | "linkOff";
  /** For cause "role": what changed. */
  role?: RoleChange;
};
