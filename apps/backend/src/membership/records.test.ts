import {
  isEnrolled,
  isHexKey,
  parseDeviceName,
  parseAnswer,
  parseDeviceSwarmKey,
  parseFolderName,
  parseJoinRequests,
  parseRegistry,
  parseRemoved,
  parseRequestsFile,
  peerName,
} from "./records";
import { describe, expect, test } from "vite-plus/test";

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

  test("accepts a declined answer and drops extra fields", () => {
    expect(parseAnswer({ code: k1, answer: "declined", shareKey: k2 })).toEqual({
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
