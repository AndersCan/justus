import { describe, expect, test } from "vite-plus/test";
import {
  buildInviteLink,
  inviteLinkFromAddress,
  linkNamedOtherAlbum,
  ownerShown,
  parseInviteLink,
} from "./invite-link";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("the https invite link", () => {
  const hints = { album: "Lisbon & co #1", ownerName: "Nils" };
  const invite = { code: A, owner: B, expiresAt: 5000 };

  test("is built on the page address with the invite after the #", () => {
    expect(buildInviteLink({ ...invite, ...hints })).toMatch(
      /^https:\/\/anderscan\.github\.io\/justus\/join\/#i=a{64}&o=b{64}&e=5&n=/,
    );
  });

  test("reads back to the same invite", () => {
    expect(parseInviteLink(buildInviteLink({ ...invite, ...hints }))).toEqual({
      kind: "invite",
      invite: { ...invite, linkAlbum: hints.album },
    });
  });

  test("is found inside a message", () => {
    const link = buildInviteLink({ ...hints, code: A, owner: B });
    expect(parseInviteLink(`Join! ${link} thanks`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B, linkAlbum: hints.album },
    });
  });

  test("still reads the justus:// form", () => {
    expect(parseInviteLink(`justus://join?i=${A}&o=${B}&n=Lisbon`).kind).toBe("invite");
  });

  test("without a # is garbled", () => {
    expect(parseInviteLink("https://anderscan.github.io/justus/join/")).toEqual({
      kind: "garbled",
    });
  });

  test("reads the page address without a trailing slash", () => {
    expect(parseInviteLink(`https://anderscan.github.io/justus/join#i=${A}&o=${B}`).kind).toBe(
      "invite",
    );
  });

  test("reads the page address in upper case", () => {
    expect(parseInviteLink(`HTTPS://AndersCan.GitHub.io/justus/join/#i=${A}&o=${B}`).kind).toBe(
      "invite",
    );
  });

  test("on another site is garbled", () => {
    expect(parseInviteLink(`https://evil.example/justus/join/#i=${A}&o=${B}`)).toEqual({
      kind: "garbled",
    });
  });

  test("a web address /join?… becomes the https link", () => {
    expect(inviteLinkFromAddress("/join", `?i=${A}&o=${B}`)).toBe(
      buildInviteLink({ code: A, owner: B, album: "", ownerName: "" }),
    );
  });
});

describe("parseInviteLink", () => {
  test("finds the link inside a message", () => {
    expect(parseInviteLink(`Join! justus://join?i=${A}&o=${B}&n=Lisbon&a=Nils thanks`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B, linkAlbum: "Lisbon" },
    });
  });

  test("keeps the album name the link carried, trimmed, and never the owner name", () => {
    expect(parseInviteLink(`justus://join?i=${A}&o=${B}&e=1&n=%20Holiday%20&a=Mallory`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B, expiresAt: 1000, linkAlbum: "Holiday" },
    });
  });

  test("a link with no album name, or a blank one, has no linkAlbum", () => {
    expect(parseInviteLink(`justus://join?i=${A}&o=${B}&a=Mallory`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B },
    });
    expect(parseInviteLink(`justus://join?i=${A}&o=${B}&n=%20%20&a=`)).toEqual({
      kind: "invite",
      invite: { code: A, owner: B },
    });
  });

  test("lowercases the code and owner", () => {
    const parsed = parseInviteLink(`justus://join?i=${A.toUpperCase()}&o=${B.toUpperCase()}`);
    expect(parsed).toEqual({
      kind: "invite",
      invite: { code: A, owner: B },
    });
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
  test("carries no name, even when the link has one", () => {
    expect(parseInviteLink(`justus://join/${A}?n=Lisbon&a=Nils`)).toEqual({ kind: "old" });
  });

  test("reads one with no hint", () => {
    expect(parseInviteLink(`justus://join/${A}`)).toEqual({ kind: "old" });
  });

  test("finds it inside a message", () => {
    expect(parseInviteLink(`Join! justus://join/${A}?a=Nils thanks`)).toEqual({ kind: "old" });
  });

  test("a key longer than 64 hex is garbled", () => {
    expect(parseInviteLink(`justus://join/${A}a`)).toEqual({ kind: "garbled" });
  });
});

describe("buildInviteLink", () => {
  test("round-trips the end time in whole seconds", () => {
    const invite = { code: A, owner: B, expiresAt: 1_700_000_123_000 };
    const hints = { album: "Lisbon", ownerName: "Nils" };
    expect(parseInviteLink(buildInviteLink({ ...invite, ...hints }))).toEqual({
      kind: "invite",
      invite: { ...invite, linkAlbum: "Lisbon" },
    });
    expect(buildInviteLink({ ...invite, ...hints, expiresAt: 1_700_000_123_999 })).toContain(
      "e=1700000123&",
    );
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

  test("writes awkward names for the browser page and the app reads the album name back", () => {
    const invite = { code: A, owner: B };
    const link = buildInviteLink({ ...invite, album: "Spain & 2026 = fun?", ownerName: "Zoë #1" });
    expect(link).toContain("n=Spain+%26+2026+%3D+fun%3F&a=Zo%C3%AB+%231");
    expect(parseInviteLink(link)).toEqual({
      kind: "invite",
      invite: { ...invite, linkAlbum: "Spain & 2026 = fun?" },
    });
  });
});

describe("inviteLinkFromAddress", () => {
  const code = "a".repeat(64);
  const owner = "b".repeat(64);
  const search = `?i=${code}&o=${owner}&n=Garden&a=Tom`;
  const link = buildInviteLink({ code, owner, album: "", ownerName: "" });

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

describe("linkNamedOtherAlbum", () => {
  test.each([
    ["Grandma's photos", "Party", true],
    ["Party", "Party", false],
    [" party ", "PARTY", false],
    ["Party", " party ", false],
    [undefined, "Party", false],
    ["", "Party", false],
    ["   ", "Party", false],
    ["Party", "", false],
  ] as const)("link %j against heard %j differs: %s", (link, heard, differs) => {
    expect(linkNamedOtherAlbum(link, heard)).toBe(differs);
  });
});

describe("ownerShown", () => {
  test.each([
    ["Ada", "mid", "Ada"],
    ["ada", "start", "ada"],
    ["", "mid", "the person who invited you"],
    ["  ", "start", "The person who invited you"],
    ["the Admin", "start", "The person who invited you"],
    ["the Admin", "mid", "the person who invited you"],
  ] as const)("%j at %s reads %j", (name, at, shown) => {
    expect(ownerShown(name, at)).toBe(shown);
  });

  test("a web address round-trips to the invite alone", () => {
    const link = inviteLinkFromAddress("/join", `?i=${A}&o=${B}&n=Holiday&a=Mallory`);
    expect(parseInviteLink(link ?? "")).toEqual({ kind: "invite", invite: { code: A, owner: B } });
  });
});
