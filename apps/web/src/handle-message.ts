import type { WireMessage } from "@ekrooh/bare/core";
import { photoSpecs, type LinkOffWhy } from "@justus/core";
import { guardPush } from "./contract-guard";
import { folders } from "./machines/folders-machine";
import { gallery } from "./machines/gallery-machine";
import { requests } from "./machines/requests-machine";
import { friendOffer } from "./machines/sharing/friend-offer";
import { join } from "./machines/sharing/join-request";
import type { RequestAnswer } from "./machines/sharing/join-request-machine";
import { sync } from "./machines/sync-machine";
import { deletedNote, type DeletedIn } from "./views/deleted-note";
import { roleToast, type RoleChangeIn } from "./views/role-toast";

/** The `cause` carried in a `photos.changed` dispatch, if any. */
export function changeCause(header: unknown): string | undefined {
  const args = (header as { args?: { cause?: unknown } }).args;
  return typeof args?.cause === "string" ? args.cause : undefined;
}

const linkOffWhys: readonly unknown[] = ["expired", "turnedOff", "replaced", "albumDeleted"];

/** The Admin's answer carried by a `photos.changed` push with cause "ask". */
export function askAnswer(args: unknown): RequestAnswer | undefined {
  const a = (args ?? {}) as {
    cause?: unknown;
    code?: unknown;
    answer?: unknown;
    folderId?: unknown;
    why?: unknown;
  };
  if (a.cause !== "ask" || typeof a.code !== "string") return undefined;
  if (a.answer === "declined") return { code: a.code, answer: "declined" };
  if (a.answer === "linkOff") {
    const why = linkOffWhys.includes(a.why) ? (a.why as LinkOffWhy) : undefined;
    return { code: a.code, answer: "linkOff", why };
  }
  if (a.answer !== "accepted") return undefined;
  return {
    code: a.code,
    answer: "accepted",
    folderId: typeof a.folderId === "string" ? a.folderId : undefined,
  };
}

/** The role change carried by a `photos.changed` push with cause "role". */
export function roleChangeOf(args: unknown): RoleChangeIn | undefined {
  const a = (args ?? {}) as { cause?: unknown; folderId?: unknown; role?: unknown };
  if (a.cause !== "role" || typeof a.folderId !== "string") return undefined;
  if (typeof a.role !== "object" || a.role === null) return undefined;
  return { ...(a.role as Omit<RoleChangeIn, "folderId">), folderId: a.folderId };
}

/** The deleted photos carried by a `photos.changed` push with cause "deleted". */
export function deletedOf(args: unknown): DeletedIn | undefined {
  const a = (args ?? {}) as { cause?: unknown; folderId?: unknown; deleted?: unknown };
  if (a.cause !== "deleted" || typeof a.folderId !== "string") return undefined;
  if (typeof a.deleted !== "object" || a.deleted === null) return undefined;
  return { ...(a.deleted as Omit<DeletedIn, "folderId">), folderId: a.folderId };
}

/** Routes inbound wire messages: backend→web pushes refresh the actors;
 * invoke failures log. */
export function handleMessage(msg: WireMessage) {
  const h = msg.header;
  const changed = photoSpecs.changed;
  if (h.type === "DISPATCH" && h.pluginId === changed.pluginId && h.event === changed.name) {
    // A malformed push is reported by field, not acted on.
    if (!guardPush(h.args)) return;
    // A presence change only moves the member list; skip the heavy reloads.
    if (changeCause(h) === "presence") {
      sync.refresh();
      return;
    }
    // Who holds a photo changed: only the open photo's line needs the new list.
    if (changeCause(h) === "holders") {
      gallery.load();
      return;
    }
    // A delete found by a list that is already current: tell the person, reload nothing.
    const deleted = deletedOf(h.args);
    if (deleted) {
      deletedNote.add(deleted);
      return;
    }
    gallery.synced(Date.now());
    gallery.load();
    sync.refresh();
    folders.refresh();
    requests.refresh();
    const roleChange = roleChangeOf(h.args);
    if (roleChange) roleToast.changed(roleChange);
    const answer = askAnswer(h.args);
    if (answer) {
      join.requestAnswered(answer);
      if (answer.answer === "accepted") {
        friendOffer.askAnswered(answer.code, answer.answer, answer.folderId);
      } else if (answer.answer === "declined") {
        friendOffer.askAnswered(answer.code, answer.answer);
      }
    }
  } else if (h.type === "INVOKE_RESPONSE" && h.error) {
    console.error("Plugin invoke failed:", h.pluginId, h.event, h.error.message);
  }
}
