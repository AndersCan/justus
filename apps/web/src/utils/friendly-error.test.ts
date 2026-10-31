import { describe, expect, it } from "vite-plus/test";
import { friendlyError } from "./friendly-error";

describe("friendlyError", () => {
  it("translates backend validation into plain words", () => {
    expect(friendlyError("Share key must be a 64-char hex key")).toBe(
      "That invite link doesn't look right. Check you copied all of it.",
    );
    expect(friendlyError("Readers cannot add photos")).toMatch(/until the Admin approves you/);
    expect(friendlyError("Only the creator can respond to requests")).toMatch(/^Only the Admin/);
  });

  it("never shows code words or internals", () => {
    for (const raw of [
      "Internal error (effect): boom",
      "Cannot open album: no such object: x",
      "Failed to store photo: EIO",
      "join returned no status",
      "Drive key must be a 64-char hex key",
    ]) {
      expect(friendlyError(raw)).not.toMatch(/hex|creator|reader|Internal|returned|EIO|object/i);
    }
  });

  it("covers the common backend and transport failures", () => {
    const cases: [string, RegExp][] = [
      ["timeout opening remote drive", /^Couldn't find the album/],
      ["No album is active", /^Couldn't open that album/],
      ["Album name is required", /^Enter a name/],
      ["Member already enrolled", /already add photos/],
      ["No such member", /isn't in this album/],
      ["Requester key must be a 64-char hex key", /doesn't look right/],
      ["Failed to fetch", /^Couldn't reach Justus/],
      ["HTTP 500", /^Couldn't reach Justus/],
    ];
    for (const [raw, expected] of cases) expect(friendlyError(raw)).toMatch(expected);
  });

  it("keeps messages that are already written for people", () => {
    const own = "That invite doesn't look right. Check you copied all of it.";
    expect(friendlyError(own)).toBe(own);
  });

  it("falls back to a generic sentence", () => {
    expect(friendlyError("ECONNRESET 0xdeadbeef")).toBe("Something went wrong. Try again.");
  });
});
