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
};

export type SyncMember = {
  key: string;
  name: string;
};

export type SyncStatus = {
  /** This device's role in the folder. */
  role: Role;
  /** This device's name (from its own `/device.json`). */
  name: string;
  /** This device's drive key (hex). Empty for readers. */
  driveKey: string;
  /** The folder's share key — the creator drive's key (hex). */
  shareKey: string;
  /** This device's drive discovery topic (hex). */
  discoveryKey: string;
  peers: number;
  photos: number;
  members: SyncMember[];
};

export type PhotoChangedCause = "add" | "remove" | "enroll" | "unenroll";

/** Backend → web push payload for the `photos.changed` dispatch. */
export type PhotoChanged = {
  cause: PhotoChangedCause;
  memberKey?: string;
};
