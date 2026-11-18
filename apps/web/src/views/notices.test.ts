import { describe, expect, it } from "vite-plus/test";
import {
  albumNoticeText,
  deletedNoticeText,
  joinedText,
  updateLines,
  youLeftText,
} from "./notices";

describe("deletedNoticeText", () => {
  it("names the Admin and the album", () => {
    expect(deletedNoticeText({ id: "f", name: "Hytta 2025", adminName: "Nils" })).toBe(
      "Nils deleted “Hytta 2025”. The album and its photos were removed from this phone.",
    );
  });

  it("falls back to the Admin when the name is unknown", () => {
    expect(deletedNoticeText({ id: "f", name: "Hytta", adminName: "" })).toBe(
      "The Admin deleted “Hytta”. The album and its photos were removed from this phone.",
    );
  });
});

describe("albumNoticeText", () => {
  it("tells the Admin to invite again", () => {
    expect(albumNoticeText({ kind: "newKey" }, "Trip")).toBe(
      "This album has a new key. Invite your members again.",
    );
  });

  it("tells a member who to ask", () => {
    expect(albumNoticeText({ kind: "moved", ownerName: "Nils" }, "Trip")).toBe(
      "This album has a new key. Ask Nils for a new invite link.",
    );
    expect(albumNoticeText({ kind: "moved" }, "Trip")).toBe(
      "This album has a new key. Ask the Admin for a new invite link.",
    );
  });

  it("tells the new Admin who handed the album over", () => {
    expect(albumNoticeText({ kind: "madeAdmin", fromName: "Ada" }, "Summer")).toBe(
      "Ada handed Summer to you. You're the Admin now: you accept new people.",
    );
  });

  it("names the Admin generically when the old Admin's name is empty", () => {
    expect(albumNoticeText({ kind: "madeAdmin", fromName: "" }, "Summer")).toBe(
      "The Admin handed Summer to you. You're the Admin now: you accept new people.",
    );
  });

  it("is empty without a notice", () => {
    expect(albumNoticeText(undefined, "Trip")).toBeNull();
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

describe("albumNoticeText removed", () => {
  it("names the album", () => {
    expect(albumNoticeText({ kind: "removed" }, "Trip")).toBe("You're no longer in Trip.");
  });
});

describe("joinedText", () => {
  it("says the person is now in the album", () => {
    expect(joinedText("Summer")).toBe("You're now in “Summer”.");
  });
});

describe("youLeftText", () => {
  it("says the person left the album", () => {
    expect(youLeftText("Summer")).toBe("You left “Summer”.");
  });
});
