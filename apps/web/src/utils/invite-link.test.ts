import { describe, expect, test } from "vite-plus/test";
import { MAX_HINT, buildInviteLink, inviteLinkFromAddress, parseInviteLink } from "./invite-link";

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
    ["old-style link with a short key", "justus://join/abc"],
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

describe("parseInviteLink old links", () => {
  test("reads the owner hint", () => {
    expect(parseInviteLink(`justus://join/${A}?n=Lisbon&a=Nils`)).toEqual({
      kind: "old",
      ownerName: "Nils",
    });
  });

  test("falls back without a hint", () => {
    expect(parseInviteLink(`justus://join/${A}`)).toEqual({ kind: "old", ownerName: "the Admin" });
  });

  test("finds it inside a message", () => {
    expect(parseInviteLink(`Join! justus://join/${A}?a=Nils thanks`)).toEqual({
      kind: "old",
      ownerName: "Nils",
    });
  });

  test("a key longer than 64 hex is garbled", () => {
    expect(parseInviteLink(`justus://join/${A}a`)).toEqual({ kind: "garbled" });
  });
});

describe("buildInviteLink", () => {
  test("round-trips the end time in whole seconds", () => {
    const invite = {
      code: A,
      owner: B,
      album: "Lisbon",
      ownerName: "Nils",
      expiresAt: 1_700_000_123_000,
    };
    expect(parseInviteLink(buildInviteLink(invite))).toEqual({ kind: "invite", invite });
    expect(buildInviteLink({ ...invite, expiresAt: 1_700_000_123_999 })).toContain("e=1700000123&");
  });

  test("a link without e never expires", () => {
    const link = buildInviteLink({ code: A, owner: B, album: "Lisbon", ownerName: "Nils" });
    expect(link).not.toContain("e=");
    const parsed = parseInviteLink(link);
    if (parsed.kind !== "invite") throw new Error("expected invite");
    expect(parsed.invite.expiresAt).toBeUndefined();
  });

  test("e=1 is one second after the epoch", () => {
    const parsed = parseInviteLink(`justus://join?i=${A}&o=${B}&e=1`);
    if (parsed.kind !== "invite") throw new Error("expected invite");
    expect(parsed.invite.expiresAt).toBe(1000);
  });

  test.each(["", "abc", "0", "-5", "1.5", "1e3", "1234567890123"])("garbled e=%s", (e) => {
    expect(parseInviteLink(`justus://join?i=${A}&o=${B}&e=${e}`)).toEqual({ kind: "garbled" });
  });

  test("round-trips, including awkward names", () => {
    const invite = { code: A, owner: B, album: "Spain & 2026 = fun?", ownerName: "Zoë #1" };
    expect(parseInviteLink(buildInviteLink(invite))).toEqual({ kind: "invite", invite });
  });
});

describe("inviteLinkFromAddress", () => {
  const code = "a".repeat(64);
  const owner = "b".repeat(64);
  const search = `?i=${code}&o=${owner}&n=Garden&a=Tom`;
  const link = buildInviteLink({ code, owner, album: "Garden", ownerName: "Tom" });

  test("reads /join?... as the link a phone app hands over", () => {
    expect(inviteLinkFromAddress("/join", search)).toBe(link);
  });
  test("ignores case and a trailing slash in the path", () => {
    expect(inviteLinkFromAddress("/JOIN/", search)).toBe(link);
  });
  test("lowercases the keys and keeps the expiry", () => {
    const e = `?i=${code.toUpperCase()}&o=${owner}&e=1800000000`;
    expect(inviteLinkFromAddress("/join", e)).toContain(`i=${code}`);
    expect(inviteLinkFromAddress("/join", e)).toContain("e=1800000000");
  });
  test("is undefined for another path, no query, or a missing key", () => {
    expect(inviteLinkFromAddress("/welcome", search)).toBeUndefined();
    expect(inviteLinkFromAddress("/join", "")).toBeUndefined();
    expect(inviteLinkFromAddress("/join", `?i=${code}`)).toBeUndefined();
  });
});
