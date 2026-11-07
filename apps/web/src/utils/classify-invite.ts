import type { AskSummary, FolderSummary } from "@justus/core";
import type { Known } from "../machines/sharing/join-request-machine";

/** What this phone already knows about an invite code: its own album, one it
 * joined through that code, a request still waiting, a request declined, or nothing. */
export function classifyInvite(
  code: string,
  folders: readonly FolderSummary[],
  asks: readonly AskSummary[],
): Known {
  const folder = folders.find((f) => f.invite?.code === code);
  if (folder) {
    return folder.role === "creator"
      ? { kind: "own", folderId: folder.id }
      : { kind: "member", folderId: folder.id };
  }
  const ask = asks.find((a) => a.code === code);
  if (ask) return { kind: ask.status };
  return { kind: "new" };
}
