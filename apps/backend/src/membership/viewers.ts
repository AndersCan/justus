/**
 * Viewers: people the Admin accepted who see every photo and add none. The
 * list is `/viewers.json` on the album's own drive; only the Admin writes it.
 * Ports only (ADR 0002).
 */
import type { JoinRequest } from "@justus/core";
import type { Drive } from "../ports/drive-store";
import { DRIVE_PATH_VIEWERS, type JoinError } from "./join";
import type { RegistryFile, ViewersFile } from "./records";

export type ViewerResult<T> = [JoinError, null] | [null, T];

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
