import {
  isEnrolled,
  isHexKey,
  identityMessage,
  verifiedDeviceIdentity,
  parseDeviceName,
  parseAnswer,
  parseFriendMessage,
  isFriendMessageShape,
  parseDeviceSwarmKey,
  parseFolderName,
  parseJoinRequests,
  boxKeyOf,
  parseSealedAsk,
  sealedAskBytes,
  parseRegistry,
  parseRemoved,
  parseRequestsFile,
  invitesAsked,
  inLinkTime,
  CLOCK_SLACK_MS,
  parseViewers,
  peerName,
} from "./records";
import { describe, expect, test } from "vite-plus/test";
import type { IdentityProof } from "../ports/drive-store";

const KEY_A = "a".repeat(64);
const KEY_B = "B".repeat(64);
const SHARE = "c".repeat(64);
const target = { shareKey: SHARE, folderId: "f1", folderName: "Holiday" };

describe("isHexKey", () => {
  test("returns true for 64 hex chars of either case", () => {
    expect(isHexKey(KEY_A)).toBe(true);
    expect(isHexKey(KEY_B)).toBe(true);
  });
  test("returns false for wrong length and non-hex", () => {
    expect(isHexKey("a".repeat(63))).toBe(false);
    expect(isHexKey("a".repeat(65))).toBe(false);
    expect(isHexKey("g".repeat(64))).toBe(false);
    expect(isHexKey("")).toBe(false);
  });
});

describe("peerName", () => {
  test("returns the trimmed name clipped to 80 characters", () => {
    expect(peerName("  Ann  ", "x")).toBe("Ann");
    expect(peerName("n".repeat(200), "x")).toBe("n".repeat(80));
  });
  test("returns the fallback for non-strings and blank names", () => {
    expect(peerName(42, "x")).toBe("x");
    expect(peerName(undefined, "x")).toBe("x");
    expect(peerName("   ", "x")).toBe("x");
  });
});

describe("parseRegistry", () => {
  const empty = { version: 1, members: {} };
  const members = { m1: { key: KEY_A, name: "Ann", addedAt: 5 } };
  test("returns the contents of a version 1 file", () => {
    expect(parseRegistry(JSON.stringify({ version: 1, members }))).toEqual({ version: 1, members });
  });
  test("returns an empty registry when missing, malformed, wrong-version or non-object", () => {
    expect(parseRegistry(null)).toEqual(empty);
    expect(parseRegistry("{nope")).toEqual(empty);
    expect(parseRegistry(JSON.stringify({ version: 2, members }))).toEqual(empty);
    expect(parseRegistry(JSON.stringify({ version: 1, members: "x" }))).toEqual(empty);
    expect(parseRegistry("null")).toEqual(empty);
  });
});

describe("isEnrolled", () => {
  const registry = parseRegistry(
    JSON.stringify({ version: 1, members: { m1: { key: KEY_A, name: "Ann", addedAt: 5 } } }),
  );
  test("returns true only for an enrolled member key", () => {
    expect(isEnrolled(registry, KEY_A)).toBe(true);
    expect(isEnrolled(registry, KEY_B)).toBe(false);
  });
});

describe("parseRemoved", () => {
  const removed = { m1: { memberKey: KEY_A, removedAt: 9 } };
  test("returns the contents of a version 1 file", () => {
    expect(parseRemoved(JSON.stringify({ version: 1, removed }))).toEqual(removed);
  });
  test("returns an empty map when missing, malformed, wrong-version or non-object", () => {
    expect(parseRemoved(null)).toEqual({});
    expect(parseRemoved("{nope")).toEqual({});
    expect(parseRemoved(JSON.stringify({ version: 2, removed }))).toEqual({});
    expect(parseRemoved(JSON.stringify({ version: 1, removed: 3 }))).toEqual({});
  });
});

describe("parseFolderName", () => {
  test("returns the trimmed name clipped to 80 characters", () => {
    expect(parseFolderName(JSON.stringify({ version: 1, name: " Trip " }))).toBe("Trip");
    expect(parseFolderName(JSON.stringify({ version: 1, name: "n".repeat(200) }))).toBe(
      "n".repeat(80),
    );
  });
  test("returns an empty name when missing, malformed, wrong-version or non-string", () => {
    expect(parseFolderName(null)).toBe("");
    expect(parseFolderName("{nope")).toBe("");
    expect(parseFolderName(JSON.stringify({ version: 2, name: "Trip" }))).toBe("");
    expect(parseFolderName(JSON.stringify({ version: 1, name: 7 }))).toBe("");
  });
});

describe("parseDeviceName", () => {
  test("returns the trimmed name clipped to 80 characters", () => {
    expect(parseDeviceName(JSON.stringify({ name: " Pixel " }))).toBe("Pixel");
    expect(parseDeviceName(JSON.stringify({ name: "n".repeat(200) }))).toBe("n".repeat(80));
  });
  test("returns the fallback when missing, empty, malformed or non-string", () => {
    expect(parseDeviceName(null)).toBe("Unknown device");
    expect(parseDeviceName("")).toBe("Unknown device");
    expect(parseDeviceName("{nope")).toBe("Unknown device");
    expect(parseDeviceName(JSON.stringify({ name: 1 }))).toBe("Unknown device");
  });
});

describe("parseDeviceSwarmKey", () => {
  test("returns a hex swarm key as written", () => {
    expect(parseDeviceSwarmKey(JSON.stringify({ swarmKey: KEY_B }))).toBe(KEY_B);
  });
  test("returns undefined for malformed, missing, non-hex and wrong-length keys", () => {
    expect(parseDeviceSwarmKey("{nope")).toBeUndefined();
    expect(parseDeviceSwarmKey(JSON.stringify({}))).toBeUndefined();
    expect(parseDeviceSwarmKey(JSON.stringify({ swarmKey: "z".repeat(64) }))).toBeUndefined();
    expect(parseDeviceSwarmKey(JSON.stringify({ swarmKey: "a".repeat(10) }))).toBeUndefined();
    expect(parseDeviceSwarmKey(JSON.stringify({ swarmKey: 5 }))).toBeUndefined();
  });
});

describe("verifiedDeviceIdentity", () => {
  const driveKey = KEY_A;
  const proofFields = { identityPublicKey: "c".repeat(64), identitySig: "d".repeat(128) };
  const check = (record: unknown, verify: (proof: IdentityProof) => boolean = () => true) =>
    verifiedDeviceIdentity(typeof record === "string" ? record : JSON.stringify(record), {
      driveKey,
      verify,
    });

  test("returns a verified identity key lowercased, checked against this drive's message", () => {
    const seen: IdentityProof[] = [];
    const identity = check({ identityKey: KEY_B, ...proofFields }, (proof) => {
      seen.push(proof);
      return true;
    });
    expect(identity).toEqual({ status: "verified", identityKey: KEY_B.toLowerCase() });
    expect(seen).toEqual([
      {
        identityKey: KEY_B,
        publicKey: proofFields.identityPublicKey,
        signature: proofFields.identitySig,
        message: identityMessage(driveKey),
      },
    ]);
  });
  test("is rejected when the signature does not verify", () => {
    expect(check({ identityKey: KEY_B, ...proofFields }, () => false)).toEqual({
      status: "rejected",
    });
  });
  test("is unsigned without proof fields, and the verifier is not asked", () => {
    const never = () => {
      throw new Error("verify called");
    };
    expect(check({ identityKey: KEY_B }, never)).toEqual({ status: "unsigned" });
    expect(check({ identityKey: KEY_B, name: "old build" }, never)).toEqual({ status: "unsigned" });
  });
  test("is rejected with one proof field missing, of the wrong type or the wrong length", () => {
    const rejected = { status: "rejected" };
    expect(check({ identityKey: KEY_B, identitySig: proofFields.identitySig })).toEqual(rejected);
    expect(check({ identityKey: KEY_B, identityPublicKey: proofFields.identityPublicKey })).toEqual(
      rejected,
    );
    expect(check({ identityKey: KEY_B, identityPublicKey: 5, identitySig: "x" })).toEqual(rejected);
    expect(check({ identityKey: KEY_B, ...proofFields, identitySig: "d".repeat(127) })).toEqual(
      rejected,
    );
    expect(
      check({ identityKey: KEY_B, ...proofFields, identityPublicKey: "c".repeat(63) }),
    ).toEqual(rejected);
  });
  test("is unsigned for missing, non-hex, short, non-string and non-JSON keys", () => {
    const unsigned = { status: "unsigned" };
    expect(check({ ...proofFields })).toEqual(unsigned);
    expect(check({ identityKey: "z".repeat(64), ...proofFields })).toEqual(unsigned);
    expect(check({ identityKey: "a".repeat(63), ...proofFields })).toEqual(unsigned);
    expect(check({ identityKey: 5, ...proofFields })).toEqual(unsigned);
    expect(check("{nope")).toEqual(unsigned);
  });
  test("is unsigned when verify throws", () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(check({ identityKey: KEY_B, ...proofFields }, boom)).toEqual({ status: "unsigned" });
  });
});

describe("parseRequestsFile", () => {
  const requests = {
    [SHARE]: {
      requesterKey: KEY_A,
      requesterName: "Ann",
      shareKey: SHARE,
      folderName: "Holiday",
      requestedAt: 1,
    },
  };
  test("returns the contents of a version 1 file", () => {
    expect(parseRequestsFile(JSON.stringify({ version: 1, requests }))).toEqual({
      version: 1,
      requests,
    });
  });
  test("returns undefined for malformed, wrong-version and non-object files", () => {
    expect(parseRequestsFile("{nope")).toBeUndefined();
    expect(parseRequestsFile(JSON.stringify({ version: 2, requests }))).toBeUndefined();
    expect(parseRequestsFile(JSON.stringify({ version: 1, requests: "x" }))).toBeUndefined();
  });
});

function file(requests: unknown): string {
  return JSON.stringify({ version: 1, requests });
}

describe("parseJoinRequests", () => {
  const entry = {
    requesterKey: KEY_B,
    requesterName: "Ann",
    shareKey: SHARE,
    folderName: "Trip",
    requestedAt: 12,
  };

  test("returns a valid entry with the requester key lowercased", () => {
    expect(parseJoinRequests(file({ [SHARE]: entry }), target)).toEqual([
      {
        requesterKey: KEY_B.toLowerCase(),
        requesterName: "Ann",
        folderId: "f1",
        folderName: "Trip",
        shareKey: SHARE,
        requestedAt: 12,
      },
    ]);
  });
  test("returns clipped names and falls back for blank ones", () => {
    const text = file({
      a: { ...entry, requesterName: "n".repeat(200), folderName: " " },
    });
    expect(parseJoinRequests(text, target)).toEqual([
      {
        requesterKey: KEY_B.toLowerCase(),
        requesterName: "n".repeat(80),
        folderId: "f1",
        folderName: "Holiday",
        shareKey: SHARE,
        requestedAt: 12,
      },
    ]);
  });
  test("returns 0 for non-finite or missing requestedAt", () => {
    const text = file({ a: { ...entry, requestedAt: "soon" }, b: { ...entry, requestedAt: null } });
    expect(parseJoinRequests(text, target).map((r) => r.requestedAt)).toEqual([0, 0]);
  });
  test("skips other albums, non-hex keys and non-object entries", () => {
    const text = file({
      other: { ...entry, shareKey: "d".repeat(64) },
      bad: { ...entry, requesterKey: "z".repeat(64) },
      num: { ...entry, requesterKey: 5 },
      str: "x",
      nil: null,
    });
    expect(parseJoinRequests(text, target)).toEqual([]);
  });
  test("returns nothing for malformed or wrong-version files", () => {
    expect(parseJoinRequests("{nope", target)).toEqual([]);
    expect(
      parseJoinRequests(JSON.stringify({ version: 2, requests: { a: entry } }), target),
    ).toEqual([]);
  });

  describe("invite entries", () => {
    const CODE = "d".repeat(64);
    const v2 = { requesterKey: KEY_B, requesterName: "Bo", invite: CODE, requestedAt: 5 };
    const withCode = { ...target, inviteCode: CODE };

    test("matches the invite code and reports the album's own share key", () => {
      expect(parseJoinRequests(file({ ["invite:" + CODE]: v2 }), withCode)).toEqual([
        {
          requesterKey: KEY_B.toLowerCase(),
          requesterName: "Bo",
          folderId: "f1",
          folderName: "Holiday",
          shareKey: SHARE,
          requestedAt: 5,
        },
      ]);
    });
    test("ignores another album's code and a target without a code", () => {
      const text = file({ x: { ...v2, invite: "e".repeat(64) } });
      expect(parseJoinRequests(text, withCode)).toEqual([]);
      expect(parseJoinRequests(file({ x: v2 }), target)).toEqual([]);
    });
    test("an entry cannot borrow another album through a bogus share key", () => {
      const text = file({ x: { ...v2, shareKey: "f".repeat(64) } });
      expect(parseJoinRequests(text, withCode)[0]?.shareKey).toBe(SHARE);
    });
  });
});

describe("parseAnswer", () => {
  const k1 = "a".repeat(64);
  const k2 = "b".repeat(64);

  test("accepts an accepted answer with a share key", () => {
    expect(parseAnswer({ code: k1, answer: "accepted", shareKey: k2 })).toEqual({
      code: k1,
      answer: "accepted",
      shareKey: k2,
    });
  });

  test("keeps movedFrom when every item is a key, else drops it and keeps the answer", () => {
    const base = { code: k1, answer: "accepted", shareKey: k2 };
    expect(parseAnswer({ ...base, movedFrom: [k1, k2] })).toEqual({ ...base, movedFrom: [k1, k2] });
    for (const bad of ["x", [], [k1, "nope"], [k1, 5], { 0: k1 }]) {
      expect(parseAnswer({ ...base, movedFrom: bad })).toEqual(base);
    }
  });

  test("accepts a declined answer and drops extra fields", () => {
    expect(parseAnswer({ code: k1, answer: "declined", shareKey: k2 })).toEqual({
      code: k1,
      answer: "declined",
    });
  });

  test("keeps the time of the declined ask, only when it is a number", () => {
    expect(parseAnswer({ code: k1, answer: "declined", askedAt: 5 })).toEqual({
      code: k1,
      answer: "declined",
      askedAt: 5,
    });
    expect(parseAnswer({ code: k1, answer: "declined", askedAt: "5" })).toEqual({
      code: k1,
      answer: "declined",
    });
  });

  test.each([
    ["null", null],
    ["a string", "accepted"],
    ["no code", { answer: "declined" }],
    ["short code", { code: "abc", answer: "declined" }],
    ["unknown answer", { code: k1, answer: "maybe" }],
    ["accepted without key", { code: k1, answer: "accepted" }],
    ["accepted with short key", { code: k1, answer: "accepted", shareKey: "abc" }],
    ["accepted with non-string key", { code: k1, answer: "accepted", shareKey: 1 }],
  ])("drops %s", (_, value) => {
    expect(parseAnswer(value)).toBeUndefined();
  });
});

describe("parseFriendMessage", () => {
  const code = "a".repeat(64);

  test("accepts an offer and cleans its names", () => {
    expect(
      parseFriendMessage({ kind: "offer", code, albumName: "  Lisbon ", ownerName: 7, extra: 1 }),
    ).toEqual({ kind: "offer", code, albumName: "Lisbon", ownerName: "the Admin" });
  });

  test("accepts each reply with only its code", () => {
    for (const kind of ["offerSeen", "offerRefused", "offerWithdrawn", "offerTaken"] as const) {
      expect(parseFriendMessage({ kind, code, shareKey: "x" })).toEqual({ kind, code });
    }
  });

  test("accepts copyDeleted and copyDeletedSeen with only a hex album", () => {
    for (const kind of ["copyDeleted", "copyDeletedSeen"] as const) {
      expect(parseFriendMessage({ kind, album: code, x: 1 })).toEqual({ kind, album: code });
      expect(parseFriendMessage({ kind, album: "nope" })).toBeUndefined();
      expect(parseFriendMessage({ kind })).toBeUndefined();
      expect(parseFriendMessage({ kind, code })).toBeUndefined();
    }
  });

  test("drops a bad code, an unknown kind and non-objects", () => {
    expect(parseFriendMessage({ kind: "offerSeen", code: "nope" })).toBeUndefined();
    expect(parseFriendMessage({ kind: "offerSeen" })).toBeUndefined();
    expect(parseFriendMessage({ kind: "other", code })).toBeUndefined();
    expect(parseFriendMessage(null)).toBeUndefined();
    expect(parseFriendMessage("offer")).toBeUndefined();
  });

  test("a friend message is never an answer, and an answer never a friend message", () => {
    expect(isFriendMessageShape({ kind: "offer", code })).toBe(true);
    expect(isFriendMessageShape({ code, answer: "declined" })).toBe(false);
    expect(parseAnswer({ kind: "offerSeen", code })).toBeUndefined();
  });
});

describe("parseViewers", () => {
  const empty = { version: 1, viewers: {} };
  const entry = { key: KEY_A, name: "Nils", addedAt: 5 };

  test("reads a good file", () => {
    const text = JSON.stringify({ version: 1, viewers: { [KEY_A]: entry } });
    expect(parseViewers(text)).toEqual({ version: 1, viewers: { [KEY_A]: entry } });
  });

  test("keeps a valid keptVersion and ignores a bad one without dropping the entry", () => {
    const read = (keptVersion: unknown) =>
      parseViewers(JSON.stringify({ version: 1, viewers: { [KEY_A]: { ...entry, keptVersion } } }))
        .viewers[KEY_A];
    expect(read(0)?.keptVersion).toBe(0);
    expect(read(12)?.keptVersion).toBe(12);
    for (const bad of [-1, 1.5, "3", null]) {
      expect(read(bad)).toEqual(entry);
    }
  });

  test("a missing, malformed or wrong-version file lists no one", () => {
    expect(parseViewers(null)).toEqual(empty);
    expect(parseViewers("not json")).toEqual(empty);
    expect(parseViewers("[]")).toEqual(empty);
    expect(parseViewers(JSON.stringify({ version: 2, viewers: { [KEY_A]: entry } }))).toEqual(
      empty,
    );
    expect(parseViewers(JSON.stringify({ version: 1, viewers: "x" }))).toEqual(empty);
  });

  test("drops a bad key, a key that does not match its record and a bad time", () => {
    const text = JSON.stringify({
      version: 1,
      viewers: {
        nothex: { key: "nothex", name: "A", addedAt: 1 },
        [KEY_A]: { key: KEY_B, name: "B", addedAt: 1 },
        [KEY_B]: { key: KEY_B, name: "C", addedAt: "soon" },
        ["c".repeat(64)]: null,
      },
    });
    expect(parseViewers(text)).toEqual(empty);
  });

  test("clips a long name and falls back for a missing one", () => {
    const text = JSON.stringify({
      version: 1,
      viewers: {
        [KEY_A]: { key: KEY_A, name: "x".repeat(500), addedAt: 1 },
        [KEY_B]: { key: KEY_B, addedAt: 2 },
      },
    });
    const { viewers } = parseViewers(text);
    expect(viewers[KEY_A].name).toHaveLength(80);
    expect(viewers[KEY_B].name).toBe("New member");
  });
});

describe("linkOff answers", () => {
  const code = "c".repeat(64);
  test("parseAnswer keeps only code, answer and askedAt", () => {
    expect(
      parseAnswer({
        code,
        answer: "linkOff",
        askedAt: 7,
        shareKey: "k".repeat(64),
        albumName: "x",
      }),
    ).toEqual({ code, answer: "linkOff", askedAt: 7 });
    expect(parseAnswer({ code, answer: "linkOff" })).toBeUndefined();
    expect(parseAnswer({ code, answer: "linkOff", askedAt: "7" })).toBeUndefined();
    expect(parseAnswer({ code, answer: "linkOff", askedAt: Number.NaN })).toBeUndefined();
  });

  test("inLinkTime: no windows count as on time; slack edges and gaps", () => {
    const links = [
      { from: 1_000_000, to: 2_000_000 },
      { from: 9_000_000, to: 9_500_000 },
    ];
    expect(inLinkTime(undefined, 5)).toBe(true);
    expect(inLinkTime([], 5)).toBe(true);
    expect(inLinkTime(links, 1_500_000)).toBe(true);
    expect(inLinkTime(links, 2_000_000 + CLOCK_SLACK_MS)).toBe(true);
    expect(inLinkTime(links, 2_000_000 + CLOCK_SLACK_MS + 1)).toBe(false);
    expect(inLinkTime(links, 1_000_000 - CLOCK_SLACK_MS)).toBe(true);
    expect(inLinkTime(links, 1_000_000 - CLOCK_SLACK_MS - 1)).toBe(false);
    expect(inLinkTime(links, 5_000_000)).toBe(false);
    expect(inLinkTime(links, 9_200_000)).toBe(true);
  });

  test("invitesAsked lists invite entries and skips the rest", () => {
    const text = JSON.stringify({
      version: 1,
      requests: {
        [`invite:${code}`]: { invite: code, requestedAt: 5 },
        plain: { shareKey: "k".repeat(64), requestedAt: 6 },
        bad: { invite: "zz", requestedAt: 6 },
        late: { invite: "d".repeat(64) },
      },
    });
    expect(invitesAsked(text)).toEqual([{ code, requestedAt: 5 }]);
    expect(invitesAsked("nope")).toEqual([]);
  });
});

describe("sealing records", () => {
  const hex = (c: string) => c.repeat(64);

  test("boxKeyOf reads a valid key, lowercased, and nothing else", () => {
    const of = (boxKey: unknown) => boxKeyOf(JSON.stringify({ boxKey }));
    expect(of(hex("a"))).toBe(hex("a"));
    expect(of(hex("A"))).toBe(hex("a"));
    expect(boxKeyOf(JSON.stringify({ name: "x" }))).toBeUndefined();
    expect(of("a".repeat(63))).toBeUndefined();
    expect(of(5)).toBeUndefined();
    expect(boxKeyOf("nope")).toBeUndefined();
    expect(boxKeyOf(null)).toBeUndefined();
  });

  test("parseSealedAsk round-trips sealedAskBytes", () => {
    const ask = { key: hex("1"), identity: hex("2"), invite: hex("3") };
    expect(parseSealedAsk(sealedAskBytes(ask))).toEqual({ v: 1, ...ask });
  });

  test("parseSealedAsk rejects other versions, missing fields and non-hex", () => {
    const good = { v: 1, key: hex("1"), identity: hex("2"), invite: hex("3") };
    const parse = (value: unknown) => parseSealedAsk(Buffer.from(JSON.stringify(value)));
    expect(parse({ ...good, v: 2 })).toBeUndefined();
    expect(parse({ ...good, key: undefined })).toBeUndefined();
    expect(parse({ ...good, identity: undefined })).toBeUndefined();
    expect(parse({ ...good, invite: undefined })).toBeUndefined();
    expect(parse({ ...good, key: "zz" })).toBeUndefined();
    expect(parse({ ...good, invite: "z".repeat(64) })).toBeUndefined();
    expect(parseSealedAsk(Buffer.from("nope"))).toBeUndefined();
    expect(parse(null)).toBeUndefined();
  });
});
