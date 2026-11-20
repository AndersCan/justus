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
  askLinkState,
  CLOCK_SLACK_MS,
  parseViewers,
  peerName,
} from "./records";
import { describe, expect, test } from "vite-plus/test";
import type { IdentityProof } from "../ports/drive-store";
import {
  MAX_ADMIN_CHAIN,
  chainReaches,
  handoverMessage,
  parseAdminNote,
  parseHandoverPackage,
  parseRemovals,
  type HandoverProof,
} from "./records";

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
  test("keeps the other entries when one entry is not an object", () => {
    const text = JSON.stringify({
      version: 1,
      members: { a: { key: KEY_A, name: "A", addedAt: 1, color: 2 }, b: null },
    });
    expect(Object.keys(parseRegistry(text).members)).toEqual(["a", "b"]);
    expect(parseRegistry(text).members.a).toMatchObject({ color: 2 });
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

  test("keeps adminDrive when it is a key other than shareKey, else drops it and keeps the answer", () => {
    const base = { code: k1, answer: "accepted", shareKey: k2 };
    expect(parseAnswer({ ...base, adminDrive: k1 })).toEqual({ ...base, adminDrive: k1 });
    for (const bad of [k2, "abc", 1, null]) {
      expect(parseAnswer({ ...base, adminDrive: bad })).toEqual(base);
    }
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

  test("reads a received answer with its names clipped and blank names empty", () => {
    const value = {
      code: k1,
      answer: "received",
      askedAt: 5,
      albumName: "Holiday",
      ownerName: "Ada",
    };
    expect(parseAnswer(value)).toEqual(value);
    expect(parseAnswer({ ...value, albumName: "x".repeat(200) })).toMatchObject({
      albumName: "x".repeat(80),
    });
    expect(parseAnswer({ ...value, ownerName: "y".repeat(200) })).toMatchObject({
      ownerName: "y".repeat(80),
    });
    expect(parseAnswer({ ...value, ownerName: "  " })).toMatchObject({ ownerName: "" });
    expect(parseAnswer({ ...value, albumName: "  ", ownerName: "" })).toMatchObject({
      albumName: "",
      ownerName: "",
    });
  });

  test.each([
    [
      "received with a bad askedAt",
      { code: k1, answer: "received", askedAt: "5", albumName: "a", ownerName: "b" },
    ],
    ["received without askedAt", { code: k1, answer: "received", albumName: "a", ownerName: "b" }],
    [
      "received with a non-string album",
      { code: k1, answer: "received", askedAt: 5, albumName: 1, ownerName: "b" },
    ],
    [
      "received with a non-string owner",
      { code: k1, answer: "received", askedAt: 5, albumName: "a", ownerName: null },
    ],
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

  test("parseAnswer keeps each known reason and drops one it does not know", () => {
    for (const why of ["expired", "turnedOff", "replaced", "albumDeleted"]) {
      expect(parseAnswer({ code, answer: "linkOff", askedAt: 7, why })).toEqual({
        code,
        answer: "linkOff",
        askedAt: 7,
        why,
      });
    }
    for (const why of ["removed", 3, null]) {
      expect(parseAnswer({ code, answer: "linkOff", askedAt: 7, why })).toEqual({
        code,
        answer: "linkOff",
        askedAt: 7,
      });
    }
  });

  test("askLinkState: the named link decides; ended wins over another live link", () => {
    const w = { from: 1_000_000, to: 2_000_000 };
    const ended = { ...w, ended: 1_600_000 };
    const other = { from: 1_000_000, to: 5_000_000 };
    expect(askLinkState(undefined, { at: 5, linkEnd: 9 })).toBe("works");
    expect(askLinkState([ended, other], { at: 1_500_000, linkEnd: 2_000_000 })).toBe("ended");
    expect(askLinkState([w], { at: 1_500_000, linkEnd: 3_000_000 })).toBe("expired");
    // No link end on the ask: the time rule, and ending every link does not open the album.
    expect(askLinkState([ended, other], { at: 1_500_000 })).toBe("works");
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

  test("parseSealedAsk keeps a valid linkEnd and drops any other, keeping the ask", () => {
    const ask = { key: hex("1"), identity: hex("2"), invite: hex("3") };
    const parse = (linkEnd: unknown) =>
      parseSealedAsk(Buffer.from(JSON.stringify({ v: 1, ...ask, linkEnd })));
    expect(parse(1_700_000_000_000)).toEqual({ v: 1, ...ask, linkEnd: 1_700_000_000_000 });
    for (const bad of ["1", -1, 0, 1.5, {}, null]) expect(parse(bad)).toEqual({ v: 1, ...ask });
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

describe("parseAdminNote", () => {
  const good = { version: 1, next: { key: KEY_B, identity: KEY_A, name: " Ben " }, at: 5 };
  test("reads a note, lowercasing the keys and cleaning the name", () => {
    expect(parseAdminNote(JSON.stringify(good))).toEqual({
      version: 1,
      next: { key: KEY_B.toLowerCase(), identity: KEY_A, name: "Ben" },
      at: 5,
    });
    expect(
      parseAdminNote(JSON.stringify({ ...good, next: { ...good.next, name: 7 } }))?.next.name,
    ).toBe("the Admin");
  });
  test("a missing file, malformed text and bad fields read as no note", () => {
    expect(parseAdminNote(null)).toBeUndefined();
    expect(parseAdminNote(undefined)).toBeUndefined();
    expect(parseAdminNote("{")).toBeUndefined();
    expect(parseAdminNote("5")).toBeUndefined();
    expect(parseAdminNote(JSON.stringify({ ...good, version: 0 }))).toBeUndefined();
    expect(parseAdminNote(JSON.stringify({ ...good, at: "x" }))).toBeUndefined();
    expect(parseAdminNote(JSON.stringify({ ...good, next: null }))).toBeUndefined();
    expect(
      parseAdminNote(JSON.stringify({ ...good, next: { ...good.next, key: "nope" } })),
    ).toBeUndefined();
    expect(
      parseAdminNote(JSON.stringify({ ...good, next: { ...good.next, identity: "nope" } })),
    ).toBeUndefined();
  });
  test("version 2 reads as no note and calls onUnsupported; version 1 does not", () => {
    let calls = 0;
    expect(parseAdminNote(JSON.stringify({ ...good, version: 2 }), () => calls++)).toBeUndefined();
    expect(calls).toBe(1);
    parseAdminNote(JSON.stringify({ ...good, version: "2" }), () => calls++);
    parseAdminNote(JSON.stringify(good), () => calls++);
    parseAdminNote("{", () => calls++);
    expect(calls).toBe(1);
  });
});

describe("chainReaches", () => {
  const ID = (n: number) => n.toString(16).padStart(64, "0");
  const link = (from: number, to: number): HandoverProof => ({
    from: ID(from),
    to: ID(to),
    publicKey: "c".repeat(64),
    signature: "d".repeat(128),
  });
  const reaches = (
    chain: HandoverProof[],
    over: Partial<{
      code: string;
      from: number;
      to: number;
      verify: (p: IdentityProof) => boolean;
    }> = {},
  ) =>
    chainReaches(chain, {
      code: KEY_A,
      from: ID(over.from ?? 1),
      to: ID(over.to ?? 3),
      verify: over.verify ?? (() => true),
    });

  test("accepts a two-link chain and asks to verify each link's own message", () => {
    const seen: IdentityProof[] = [];
    expect(
      reaches([link(1, 2), link(2, 3)], {
        verify: (p) => {
          seen.push(p);
          return true;
        },
      }),
    ).toBe(true);
    expect(seen.map((p) => [p.identityKey, p.message])).toEqual([
      [ID(1), handoverMessage(KEY_A, ID(2))],
      [ID(2), handoverMessage(KEY_A, ID(3))],
    ]);
  });
  test("starts at the link from the sender, ignoring links before it", () => {
    expect(reaches([link(9, 1), link(1, 2), link(2, 3)])).toBe(true);
  });
  test("refuses a broken link, a wrong code, a missing start and a wrong end", () => {
    expect(reaches([link(1, 2), link(5, 3)])).toBe(false);
    expect(reaches([link(1, 2), link(2, 3)], { verify: (p) => p.identityKey !== ID(2) })).toBe(
      false,
    );
    const signedForA = (p: IdentityProof) =>
      Buffer.from(p.message).toString().includes(`:${KEY_A}:`);
    expect(reaches([link(1, 2), link(2, 3)], { verify: signedForA })).toBe(true);
    expect(
      chainReaches([link(1, 2), link(2, 3)], {
        code: "b".repeat(64),
        from: ID(1),
        to: ID(3),
        verify: signedForA,
      }),
    ).toBe(false);
    expect(reaches([link(1, 2), link(2, 3)], { verify: () => false })).toBe(false);
    expect(reaches([link(2, 3)], { from: 1 })).toBe(false);
    expect(reaches([link(1, 2), link(2, 4)])).toBe(false);
    expect(reaches([])).toBe(false);
  });
  test("compares keys without case and refuses 17 links", () => {
    const upper = { ...link(10, 11), from: ID(10).toUpperCase() };
    expect(reaches([upper], { from: 10, to: 11 })).toBe(true);
    expect(reaches([{ ...link(1, 11), to: ID(11).toUpperCase() }, link(11, 3)])).toBe(true);
    expect(reaches([{ ...link(1, 12), to: ID(12).toUpperCase() }], { to: 12 })).toBe(true);
    const long = Array.from({ length: MAX_ADMIN_CHAIN + 1 }, (_, i) => link(i + 1, i + 2));
    expect(reaches(long, { from: 1, to: MAX_ADMIN_CHAIN + 2 })).toBe(false);
    expect(reaches(long.slice(0, MAX_ADMIN_CHAIN), { from: 1, to: MAX_ADMIN_CHAIN + 1 })).toBe(
      true,
    );
  });
});

describe("handover messages", () => {
  const ID = "e".repeat(64);
  const SIG = "f".repeat(128);
  const proof = { from: KEY_A, to: ID, publicKey: "c".repeat(64), signature: SIG };
  const pkg = (over: Record<string, unknown> = {}) => ({
    fromName: " Ada ",
    invite: {
      code: KEY_A,
      links: [
        { from: 1, to: 2 },
        { from: 3, to: 4, by: " Ada " },
      ],
    },
    retiredInvites: [ID],
    retiredWhy: { [ID]: "replaced" },
    answers: { [ID]: "accepted" },
    declinedAsks: { [ID]: 9 },
    chains: { [KEY_A]: [proof], [ID]: [proof] },
    ...over,
  });

  test("a package's removals parse with keys lowercased, and one bad entry refuses the package", () => {
    const parsed = parseHandoverPackage(
      pkg({ removals: { [KEY_B]: { name: " Cy ", at: 3, by: " Ada " } } }),
    );
    expect(parsed?.removals).toEqual({ [KEY_B.toLowerCase()]: { name: "Cy", at: 3, by: "Ada" } });
    expect(
      parseHandoverPackage(pkg({ removals: { [ID]: { name: "Cy", at: "x" } } })),
    ).toBeUndefined();
    expect("removals" in parseHandoverPackage(pkg())!).toBe(false);
  });

  test("parseRemovals keeps a good list and refuses a bad one", () => {
    expect(parseRemovals({ [ID]: { name: "Cy", at: 3 } })).toEqual({ [ID]: { name: "Cy", at: 3 } });
    expect(parseRemovals({ nothex: { name: "Cy", at: 3 } })).toBeUndefined();
    expect(parseRemovals({ [ID]: { name: "  ", at: 3 } })).toBeUndefined();
  });

  test("handoverReady and handoverDone carry a hex album (and a digest)", () => {
    expect(
      parseFriendMessage({ kind: "handoverReady", album: KEY_B, digest: ID, photos: KEY_A }),
    ).toEqual({
      kind: "handoverReady",
      album: KEY_B.toLowerCase(),
      digest: ID,
      photos: KEY_A.toLowerCase(),
    });
    expect(parseFriendMessage({ kind: "handoverReady", album: KEY_B, digest: ID })).toBeUndefined();
    expect(
      parseFriendMessage({ kind: "handoverReady", album: KEY_B, digest: ID, photos: "x" }),
    ).toBeUndefined();
    for (const kind of ["handoverDone"] as const) {
      expect(parseFriendMessage({ kind, album: KEY_A, digest: 5 })).toEqual({ kind, album: KEY_A });
      expect(parseFriendMessage({ kind, album: "nope" })).toBeUndefined();
      expect(parseFriendMessage({ kind })).toBeUndefined();
    }
    expect(parseFriendMessage({ kind: "handoverReady", album: KEY_A })).toBeUndefined();
    expect(
      parseFriendMessage({ kind: "handoverReady", album: KEY_A, digest: "x" }),
    ).toBeUndefined();
    expect(parseFriendMessage({ kind: "handover", album: KEY_A, digest: ID })).toBeUndefined();
    expect(
      parseFriendMessage({ kind: "handover", album: "x", digest: ID, admin: pkg() }),
    ).toBeUndefined();
    expect(parseFriendMessage({ kind: "handover", album: KEY_A, admin: pkg() })).toBeUndefined();
  });
  test("handover keeps a whole package, cleaned", () => {
    const msg = parseFriendMessage({ kind: "handover", album: KEY_A, digest: ID, admin: pkg() });
    expect(msg).toEqual({
      kind: "handover",
      album: KEY_A,
      digest: ID,
      admin: {
        fromName: "Ada",
        invite: {
          code: KEY_A,
          links: [
            { from: 1, to: 2 },
            { from: 3, to: 4, by: "Ada" },
          ],
        },
        retiredInvites: [ID],
        retiredWhy: { [ID]: "replaced" },
        answers: { [ID]: "accepted" },
        declinedAsks: { [ID]: 9 },
        chains: { [KEY_A]: [proof], [ID]: [proof] },
      },
    });
  });
  test("handover keeps when a link was ended, and drops an ended that is not a number", () => {
    const parsed = parseHandoverPackage(
      pkg({
        invite: {
          code: KEY_A,
          links: [
            { from: 1, to: 2, ended: 5 },
            { from: 3, to: 4, ended: "x" },
          ],
        },
      }),
    );
    expect(parsed?.invite.links).toEqual([
      { from: 1, to: 2, ended: 5 },
      { from: 3, to: 4 },
    ]);
  });
  test("a package may be just a code and its chain", () => {
    expect(parseHandoverPackage({ invite: { code: KEY_A }, chains: { [KEY_A]: [proof] } })).toEqual(
      {
        fromName: "the Admin",
        invite: { code: KEY_A },
        chains: { [KEY_A]: [proof] },
      },
    );
  });
  test("a package with any bad part is refused whole", () => {
    const bad = (over: Record<string, unknown>) => parseHandoverPackage(pkg(over));
    expect(parseHandoverPackage(null)).toBeUndefined();
    expect(bad({ invite: { code: "x" } })).toBeUndefined();
    expect(bad({ invite: null })).toBeUndefined();
    expect(bad({ invite: { code: KEY_A, links: "x" } })).toBeUndefined();
    expect(bad({ invite: { code: KEY_A, links: [null] } })).toBeUndefined();
    expect(bad({ invite: { code: KEY_A, links: [{ from: "1", to: 2 }] } })).toBeUndefined();
    expect(bad({ invite: { code: KEY_A, links: [{ from: 1, to: NaN }] } })).toBeUndefined();
    expect(bad({ retiredInvites: "x" })).toBeUndefined();
    expect(bad({ retiredInvites: [5] })).toBeUndefined();
    expect(bad({ retiredWhy: { [ID]: "expired" } })).toBeUndefined();
    expect(bad({ retiredWhy: { x: "replaced" } })).toBeUndefined();
    expect(bad({ answers: { [ID]: "maybe" } })).toBeUndefined();
    expect(bad({ answers: { x: "accepted" } })).toBeUndefined();
    expect(bad({ answers: "x" })).toBeUndefined();
    expect(bad({ declinedAsks: { [ID]: "9" } })).toBeUndefined();
    expect(bad({ declinedAsks: { x: 9 } })).toBeUndefined();
    expect(bad({ declinedAsks: 5 })).toBeUndefined();
  });
  test("a chain is needed for every code and for no other", () => {
    expect(parseHandoverPackage(pkg({ chains: { [KEY_A]: [proof] } }))).toBeUndefined();
    expect(
      parseHandoverPackage(pkg({ chains: { [KEY_A]: [proof], [ID]: [proof], [KEY_B]: [proof] } })),
    ).toBeUndefined();
    expect(parseHandoverPackage(pkg({ chains: null }))).toBeUndefined();
    expect(parseHandoverPackage(pkg({ chains: { [KEY_A]: [], [ID]: [proof] } }))).toBeUndefined();
  });
  test("a proof with a short key or signature, or non-hex, is refused", () => {
    const withProof = (p: unknown) => pkg({ chains: { [KEY_A]: [p], [ID]: [proof] } });
    for (const p of [
      null,
      { ...proof, from: "x" },
      { ...proof, to: "x" },
      { ...proof, publicKey: "x" },
      { ...proof, signature: "f".repeat(127) },
      { ...proof, signature: "g".repeat(128) },
    ]) {
      expect(parseHandoverPackage(withProof(p))).toBeUndefined();
    }
    expect(parseHandoverPackage(withProof({ ...proof, from: KEY_B }))?.chains[KEY_A][0].from).toBe(
      KEY_B.toLowerCase(),
    );
  });
  test("caps: 50 links, 50 retired codes, 50 retiredWhy, 1000 answers, 1000 declined, 16 links a chain", () => {
    const hex = (i: number) => i.toString(16).padStart(64, "0");
    const links = (n: number) => Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1 }));
    const codes = (n: number) => Array.from({ length: n }, (_, i) => hex(i + 1000));
    const chainsFor = (c: string[]) => Object.fromEntries([KEY_A, ...c].map((k) => [k, [proof]]));
    expect(parseHandoverPackage(pkg({ invite: { code: KEY_A, links: links(50) } }))).toBeDefined();
    expect(
      parseHandoverPackage(pkg({ invite: { code: KEY_A, links: links(51) } })),
    ).toBeUndefined();
    expect(
      parseHandoverPackage(
        pkg({ retiredInvites: codes(50), retiredWhy: undefined, chains: chainsFor(codes(50)) }),
      ),
    ).toBeDefined();
    expect(
      parseHandoverPackage(
        pkg({ retiredInvites: codes(51), retiredWhy: undefined, chains: chainsFor(codes(51)) }),
      ),
    ).toBeUndefined();
    const whyOf = (n: number) => Object.fromEntries(codes(n).map((c) => [c, "turnedOff"]));
    expect(parseHandoverPackage(pkg({ retiredWhy: whyOf(50) }))).toBeDefined();
    expect(parseHandoverPackage(pkg({ retiredWhy: whyOf(51) }))).toBeUndefined();
    const many = (n: number, v: unknown) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [hex(i + 1), v]));
    expect(parseHandoverPackage(pkg({ answers: many(1000, "accepted") }))).toBeDefined();
    expect(parseHandoverPackage(pkg({ answers: many(1001, "accepted") }))).toBeUndefined();
    expect(parseHandoverPackage(pkg({ declinedAsks: many(1000, 1) }))).toBeDefined();
    expect(parseHandoverPackage(pkg({ declinedAsks: many(1001, 1) }))).toBeUndefined();
    const longChain = (n: number) =>
      pkg({ chains: { [KEY_A]: Array(n).fill(proof), [ID]: [proof] } });
    expect(parseHandoverPackage(longChain(16))).toBeDefined();
    expect(parseHandoverPackage(longChain(17))).toBeUndefined();
  });
  test("a handedOver answer carries its code and a valid chain", () => {
    expect(parseAnswer({ code: KEY_A, answer: "handedOver", chain: [proof] })).toEqual({
      code: KEY_A,
      answer: "handedOver",
      chain: [proof],
    });
    expect(parseAnswer({ code: KEY_A, answer: "handedOver", chain: [] })).toBeUndefined();
    expect(parseAnswer({ code: KEY_A, answer: "handedOver" })).toBeUndefined();
    expect(
      parseAnswer({ code: KEY_A, answer: "handedOver", chain: [{ ...proof, to: "x" }] }),
    ).toBeUndefined();
    expect(parseAnswer({ code: "x", answer: "handedOver", chain: [proof] })).toBeUndefined();
  });
});
