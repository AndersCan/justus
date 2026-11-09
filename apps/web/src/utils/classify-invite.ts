import type { AskSummary, FolderSummary } from "@justus/core";
import type { Known } from "../machines/sharing/join-request-machine";

/** What this phone already knows about an invite code: its own album, one it
 * joined through that code, a request still waiting, a link it was told is turned off, or nothing. A declined ask counts as nothing: it can be asked again.
 * A removed album's code counts as turned off: a Remove gives the album a new link. */
export function classifyInvite(
  code: string,
  folders: readonly FolderSummary[],
  asks: readonly AskSummary[],
): Known {
  const folder = folders.find((f) => f.invite?.code === code);
  if (folder?.notice?.kind === "removed") return { kind: "turnedOff" };
  if (folder) {
    return folder.role === "creator"
      ? { kind: "own", folderId: folder.id }
      : { kind: "member", folderId: folder.id };
  }
  const ask = asks.find((a) => a.code === code);
  if (ask?.status === "waiting") return { kind: "waiting" };
  if (ask?.status === "linkOff") return { kind: "turnedOff" };
  return { kind: "new" };
}
