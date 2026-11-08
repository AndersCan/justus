import type { WireMessage } from "@ekrooh/bare/core";
import { photoSpecs } from "@justus/core";
import { guardPush } from "./contract-guard";
import { folders } from "./machines/folders-machine";
import { gallery } from "./machines/gallery-machine";
import { requests } from "./machines/requests-machine";
import { friendOffer } from "./machines/sharing/friend-offer";
import { join } from "./machines/sharing/join-request";
import { sync } from "./machines/sync-machine";

/** The `cause` carried in a `photos.changed` dispatch, if any. */
export function changeCause(header: unknown): string | undefined {
  const args = (header as { args?: { cause?: unknown } }).args;
  return typeof args?.cause === "string" ? args.cause : undefined;
}

type AskAnswer = {
  code: string;
  answer: "accepted" | "declined" | "linkOff";
  folderId: string | undefined;
};

/** The Admin's answer carried by a `photos.changed` push with cause "ask". */
export function askAnswer(args: unknown): AskAnswer | undefined {
  const a = (args ?? {}) as {
    cause?: unknown;
    code?: unknown;
    answer?: unknown;
    folderId?: unknown;
  };
  if (a.cause !== "ask" || typeof a.code !== "string") return undefined;
  if (a.answer !== "accepted" && a.answer !== "declined" && a.answer !== "linkOff")
    return undefined;
  return {
    code: a.code,
    answer: a.answer,
    folderId: typeof a.folderId === "string" ? a.folderId : undefined,
  };
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
    gallery.synced(Date.now());
    gallery.load();
    sync.refresh();
    folders.refresh();
    requests.refresh();
    const answer = askAnswer(h.args);
    if (answer) {
      join.requestAnswered(answer.code, answer.answer, answer.folderId);
      if (answer.answer !== "linkOff") {
        friendOffer.askAnswered(answer.code, answer.answer, answer.folderId);
      }
    }
  } else if (h.type === "INVOKE_RESPONSE" && h.error) {
    console.error("Plugin invoke failed:", h.pluginId, h.event, h.error.message);
  }
}
