import type { AskSummary, FolderSummary } from "@justus/core";
import type { Known } from "../machines/sharing/join-request-machine";

/** What this phone already knows about an invite code: its own album, one it
 * joined through that code, a request still waiting, a link it was told no longer works, or nothing. A declined ask counts as nothing: it can be asked again.
 * A removed album's code counts as replaced: a Remove gives the album a new link. */
export function classifyInvite(
  code: string,
  folders: readonly FolderSummary[],
  asks: readonly AskSummary[],
): Known {
  const folder = folders.find((f) => f.invite?.code === code);
  if (folder?.notice?.kind === "removed") return { kind: "stopped", why: "replaced" };
  if (folder) {
    return folder.role === "creator"
      ? { kind: "own", folderId: folder.id }
      : { kind: "member", folderId: folder.id };
  }
  const ask = asks.find((a) => a.code === code);
  if (ask?.status === "waiting") return { kind: "waiting" };
  if (ask?.status === "linkOff") return { kind: "stopped", why: ask.why };
  return { kind: "new" };
}
