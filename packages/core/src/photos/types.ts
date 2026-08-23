export type Role = "creator" | "member" | "reader";

/** Provenance of a photo: the member drive it lives in + the device name from
 * that drive's `/device.json`. */
export type PhotoMember = {
  key: string;
  name: string;
};

export type Photo = {
  /** File id within the member drive (e.g. `abc123`). */
  id: string;
  /** Loopback-served URL (same-origin, cookie-gated on device). */
  url: string;
  /** Original file name. */
  name: string;
  mime: string;
  size: number;
  addedAt: number;
  member: PhotoMember;
  /** sha256 of the original bytes (ingest dedupe). Optional: entries stored
   * before this field existed don't carry it. */
  sha256?: string;
};

export type SyncMember = {
  key: string;
  name: string;
};

/** A call A device's view of one folder it belongs to. A device can hold many
 * folders; exactly one is active (the gallery shows it). */
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
};

export type PhotoChangedCause = "add" | "remove" | "enroll" | "request";

/** Backend → web push payload for the `photos.changed` dispatch. */
export type PhotoChanged = {
  cause: PhotoChangedCause;
  /** The folder this change concerns; `undefined` while not multi-folder
   * aware (older peers). The web layer keys animation/refresh off it. */
  folderId?: string;
  memberKey?: string;
};
