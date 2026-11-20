import type { SyncStatus } from "@justus/core";
import { friendsActor } from "../machines/friends-machine";
import { presenceClockActor } from "../machines/presence-clock-machine";
import { syncActor } from "../machines/sync-machine";
import { copy } from "../copy/copy";
import { presenceWords, shownName } from "../utils/people";
import { presenceOf, type PresenceClock, type PresenceKind } from "../utils/presence";
import { announce } from "./announce";

export type PresenceSeen = {
  folderId: string;
  people: { key: string; name: string; kind: PresenceKind; words: string }[];
};

/** What each other member (not you) reads as right now, in the album the status describes. */
export function presenceSeen(
  status: SyncStatus,
  friends: Readonly<Record<string, string>>,
  clock: PresenceClock,
): PresenceSeen {
  return {
    folderId: status.folder.id,
    people: status.members.slice(1).map((m) => ({
      key: m.key,
      name: shownName(m, friends),
      kind: presenceOf(m, clock),
      words: presenceWords(m, clock),
    })),
  };
}

/** One message per person whose phone went from connected to off since `before`; none for a first status or another album. */
export function presenceChanges(before: PresenceSeen | undefined, after: PresenceSeen): string[] {
  if (before === undefined || before.folderId !== after.folderId) return [];
  return after.people
    .filter(
      (p) => p.kind === "off" && before.people.find((b) => b.key === p.key)?.kind === "connected",
    )
    .map((p) => copy("people.presence_changed", { name: p.name, presence: p.words }));
}

/** Says "Ben, Phone off, last seen just now" once when Ben's phone goes off. Returns stop. */
export function startPresenceAnnouncements(): () => void {
  let last: PresenceSeen | undefined;
  const check = () => {
    const status = syncActor.snapshot().context.status;
    if (!status) return;
    const seen = presenceSeen(
      status,
      friendsActor.snapshot().context.friends,
      presenceClockActor.snapshot().context,
    );
    const lines = presenceChanges(last, seen);
    if (lines.length > 0) announce(lines.join(". "));
    last = seen;
  };
  const stops = [syncActor, presenceClockActor].map((a) => a.on("change", { fn: check }));
  check();
  return () => stops.forEach((stop) => stop());
}
