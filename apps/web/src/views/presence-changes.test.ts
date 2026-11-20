import { describe, expect, it } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { copy } from "../copy/copy";
import { presenceChanges, presenceSeen } from "./presence-changes";

const NOW = 1_000_000;
const status = (ben: object, folderId = "f1") =>
  ({
    folder: { id: folderId },
    members: [
      { key: "me", name: "Ada", admin: true, connected: true },
      { key: "ben", name: "Ben", admin: false, ...ben },
    ],
  }) as unknown as SyncStatus;
const seen = (ben: object, now = NOW, folderId = "f1") =>
  presenceSeen(status(ben, folderId), {}, { now });
const on = { connected: true };
const off = { connected: false, lastSeenAt: NOW - 60_000 };

describe("presenceChanges", () => {
  it("says Ben's phone went off once, with the words the row shows", () => {
    const out = presenceChanges(seen(on), seen(off));
    expect(out).toEqual([
      copy("people.presence_changed", { name: "Ben", presence: seen(off).people[0].words }),
    ]);
    expect(out[0]).toContain("Ben, ");
  });
  it("says nothing on the first status", () => {
    expect(presenceChanges(undefined, seen(off))).toEqual([]);
  });
  it("says nothing for another album", () => {
    expect(presenceChanges(seen(on, NOW, "f2"), seen(off))).toEqual([]);
  });
  it("says nothing when a minute passes and the phone stays off", () => {
    expect(presenceChanges(seen(off), seen(off, NOW + 60_000))).toEqual([]);
  });
  it("says nothing when the phone comes back", () => {
    expect(presenceChanges(seen(off), seen(on))).toEqual([]);
  });
  it("says nothing for a phone that never connected", () => {
    expect(presenceChanges(seen({ connected: false }), seen(off))).toEqual([]);
  });
});
