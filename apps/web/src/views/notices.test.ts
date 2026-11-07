import { describe, expect, it } from "vite-plus/test";
import { albumNoticeText, updateLines } from "./notices";

describe("albumNoticeText", () => {
  it("tells the Admin to invite again", () => {
    expect(albumNoticeText({ kind: "newKey" })).toBe(
      "This album has a new key. Invite your members again.",
    );
  });

  it("tells a member who to ask", () => {
    expect(albumNoticeText({ kind: "moved", ownerName: "Nils" })).toBe(
      "This album has a new key. Ask Nils for a new invite link.",
    );
    expect(albumNoticeText({ kind: "moved" })).toBe(
      "This album has a new key. Ask the Admin for a new invite link.",
    );
  });

  it("is empty without a notice", () => {
    expect(albumNoticeText(undefined)).toBeNull();
  });
});

describe("updateLines", () => {
  it("is empty when everyone matches", () => {
    expect(updateLines(null)).toEqual([]);
    expect(updateLines({ updateNeeded: false, peersBehind: [] })).toEqual([]);
  });

  it("says who must update", () => {
    expect(updateLines({ updateNeeded: true, peersBehind: ["Nils", "Ida"] })).toEqual([
      "Update Justus to keep syncing",
      "Nils needs to update Justus",
      "Ida needs to update Justus",
    ]);
  });
});
