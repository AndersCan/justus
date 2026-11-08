/**
 * Viewers: people the Admin accepted who see every photo and add none. The
 * list is `/viewers.json` on the album's own drive; only the Admin writes it.
 * Ports only (ADR 0002).
 */
import type { JoinRequest } from "@justus/core";
import type { Drive } from "../ports/drive-store";
import { DRIVE_PATH_MEMBERS, DRIVE_PATH_VIEWERS, type JoinError } from "./join";
import type { RegistryFile, ViewersFile } from "./records";

export type ViewerError =
  | JoinError
  | { kind: "no-such-viewer"; message: string }
  | { kind: "no-such-member"; message: string };
export type ViewerResult<T> = [ViewerError, null] | [null, T];

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Admin only: lists `requesterKey` as a Viewer. The name comes from their
 * request, else "New member". The inputs are not changed. */
export async function seatViewer(
  folderDrive: Drive,
  options: {
    viewers: ViewersFile;
    registry: RegistryFile;
    requesterKey: string;
    requests: JoinRequest[];
  },
): Promise<ViewerResult<{ viewers: ViewersFile; viewer: ViewersFile["viewers"][string] }>> {
  const { viewers, registry, requesterKey, requests } = options;
  if (registry.members[requesterKey] || viewers.viewers[requesterKey]) {
    return [{ kind: "already-enrolled", message: "Member already enrolled" }, null];
  }
  const name = requests.find((r) => r.requesterKey === requesterKey)?.requesterName ?? "New member";
  const next: ViewersFile = {
    ...viewers,
    viewers: {
      ...viewers.viewers,
      [requesterKey]: { key: requesterKey, name, addedAt: Date.now() },
    },
  };
  try {
    await folderDrive.put(DRIVE_PATH_VIEWERS, Buffer.from(JSON.stringify(next)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  return [null, { viewers: next, viewer: next.viewers[requesterKey] }];
}

/** Admin only: takes a Viewer off `/viewers.json`. The inputs are not changed. */
export async function removeViewer(
  folderDrive: Drive,
  options: { viewers: ViewersFile; viewerKey: string },
): Promise<ViewerResult<ViewersFile>> {
  const { viewers, viewerKey } = options;
  if (!viewers.viewers[viewerKey]) {
    return [{ kind: "no-such-viewer", message: "No such Viewer" }, null];
  }
  const { [viewerKey]: _gone, ...rest } = viewers.viewers;
  const next: ViewersFile = { ...viewers, viewers: rest };
  try {
    await folderDrive.put(DRIVE_PATH_VIEWERS, Buffer.from(JSON.stringify(next)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  return [null, next];
}

/** Admin only: moves a Viewer into the registry, then out of `/viewers.json`.
 * The person keeps the `addedAt` they were listed with, so a left note written
 * before the change still reads as later than their join.
 * If the second write fails the person is in both files, and the registry
 * wins, so they already show as a Collaborator. The inputs are not changed. */
export async function makeViewerMember(
  folderDrive: Drive,
  options: { viewers: ViewersFile; registry: RegistryFile; memberKey: string },
): Promise<ViewerResult<{ viewers: ViewersFile; registry: RegistryFile }>> {
  const { viewers, registry, memberKey } = options;
  const viewer = viewers.viewers[memberKey];
  if (!viewer) return [{ kind: "no-such-viewer", message: "No such Viewer" }, null];
  if (registry.members[memberKey]) {
    return [{ kind: "already-enrolled", message: "Member already enrolled" }, null];
  }
  const nextRegistry: RegistryFile = {
    ...registry,
    members: {
      ...registry.members,
      [memberKey]: { key: viewer.key, name: viewer.name, addedAt: viewer.addedAt },
    },
  };
  try {
    await folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(nextRegistry)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  const { [memberKey]: _moved, ...rest } = viewers.viewers;
  const nextViewers: ViewersFile = { ...viewers, viewers: rest };
  try {
    await folderDrive.put(DRIVE_PATH_VIEWERS, Buffer.from(JSON.stringify(nextViewers)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  return [null, { viewers: nextViewers, registry: nextRegistry }];
}

/** Admin only: lists a Collaborator as a Viewer (keeping their `addedAt`) whose drive is read at
 * `keptVersion`, then takes them out of `/members.json`. If the second write
 * fails they are in both files and the registry wins, so they are still a
 * Collaborator and a retry finishes the job. The inputs are not changed. */
export async function makeMemberViewer(
  folderDrive: Drive,
  options: {
    viewers: ViewersFile;
    registry: RegistryFile;
    memberKey: string;
    keptVersion: number;
  },
): Promise<ViewerResult<{ viewers: ViewersFile; registry: RegistryFile; changed: boolean }>> {
  const { viewers, registry, memberKey, keptVersion } = options;
  const member = registry.members[memberKey];
  if (!member) {
    if (viewers.viewers[memberKey]) return [null, { viewers, registry, changed: false }];
    return [{ kind: "no-such-member", message: "No such member" }, null];
  }
  let nextViewers = viewers;
  if (!viewers.viewers[memberKey]) {
    nextViewers = {
      ...viewers,
      viewers: {
        ...viewers.viewers,
        [memberKey]: { key: memberKey, name: member.name, addedAt: member.addedAt, keptVersion },
      },
    };
    try {
      await folderDrive.put(DRIVE_PATH_VIEWERS, Buffer.from(JSON.stringify(nextViewers)));
    } catch (thrown: unknown) {
      return [{ kind: "write-failed", message: errText(thrown) }, null];
    }
  }
  const { [memberKey]: _moved, ...rest } = registry.members;
  const nextRegistry: RegistryFile = { ...registry, members: rest };
  try {
    await folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(nextRegistry)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  return [null, { viewers: nextViewers, registry: nextRegistry, changed: true }];
}
