import { describe, expect, test } from "vite-plus/test";
import { MAX_HINT, buildInviteLink, parseInviteLink } from "./invite-link";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("parseInviteLink", () => {
  test("finds the link inside a message", () => {
    expect(parseInviteLink(`Join! justus://join?i=${A}&o=${B}&n=Lisbon&a=Nils thanks`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B, album: "Lisbon", ownerName: "Nils" },
    });
  });

  test("lowercases the code and owner", () => {
    const parsed = parseInviteLink(`justus://join?i=${A.toUpperCase()}&o=${B.toUpperCase()}`);
    expect(parsed).toEqual({
      kind: "invite",
      invite: { code: A, owner: B, album: "this album", ownerName: "the Admin" },
    });
  });

  test("caps the hints", () => {
    const parsed = parseInviteLink(
      `justus://join?i=${A}&o=${B}&n=${"x".repeat(500)}&a=${"y".repeat(500)}`,
    );
    if (parsed.kind !== "invite") throw new Error("expected invite");
    expect(parsed.invite.album).toHaveLength(MAX_HINT);
    expect(parsed.invite.ownerName).toHaveLength(MAX_HINT);
  });

  test.each([
    ["empty", ""],
    ["no link", "hello"],
    ["old-style link", `justus://join/${A}?n=x`],
    ["bare key", A],
    ["short code", `justus://join?i=abc&o=${B}`],
    ["missing owner", `justus://join?i=${A}`],
    ["missing code", `justus://join?o=${B}`],
    ["non-hex owner", `justus://join?i=${A}&o=${"z".repeat(64)}`],
    ["long code", `justus://join?i=${A}a&o=${B}`],
  ])("%s is garbled", (_name, text) => {
    expect(parseInviteLink(text)).toEqual({ kind: "garbled" });
  });
});

describe("buildInviteLink", () => {
  test("round-trips, including awkward names", () => {
    const invite = { code: A, owner: B, album: "Spain & 2026 = fun?", ownerName: "Zoë #1" };
    expect(parseInviteLink(buildInviteLink(invite))).toEqual({ kind: "invite", invite });
  });
});
