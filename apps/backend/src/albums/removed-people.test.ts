import { describe, it, expect } from "vite-plus/test";
import type { Drive } from "../ports/drive-store";
import { DRIVE_PATH_REMOVED, addRemovedPerson, parseRemovedPeople } from "./removed-people";

const A = "a".repeat(64);
const B = "b".repeat(64);

function memoryDrive(initial?: string) {
  let text = initial ?? null;
  let writes = 0;
  const drive = {
    readSmall: async () => text,
    put: async (_path: string, data: Buffer) => {
      writes += 1;
      text = data.toString();
    },
  } as unknown as Drive;
  return { drive, text: () => text, writes: () => writes };
}

describe("parseRemovedPeople", () => {
  it("returns [] for no file, bad JSON, arrays and other versions", () => {
    expect(parseRemovedPeople(null)).toEqual([]);
    expect(parseRemovedPeople("nope")).toEqual([]);
    expect(parseRemovedPeople("[]")).toEqual([]);
    expect(parseRemovedPeople(JSON.stringify({ version: 2, keys: [A] }))).toEqual([]);
    expect(parseRemovedPeople(JSON.stringify({ version: 1, keys: "x" }))).toEqual([]);
  });

  it("lowercases, de-duplicates and drops bad keys", () => {
    const text = JSON.stringify({ version: 1, keys: [A.toUpperCase(), A, "zz", 5, B] });
    expect(parseRemovedPeople(text)).toEqual([A, B]);
  });
});

describe("addRemovedPerson", () => {
  it("adds a key once and writes nothing the second time", async () => {
    const d = memoryDrive();
    expect((await addRemovedPerson(d.drive, { key: A, log: () => {} }))[0]).toBeNull();
    expect(
      (await addRemovedPerson(d.drive, { key: A.toUpperCase(), log: () => {} }))[0],
    ).toBeNull();
    expect(d.writes()).toBe(1);
    await addRemovedPerson(d.drive, { key: B, log: () => {} });
    expect(parseRemovedPeople(d.text())).toEqual([A, B]);
  });

  it("returns the reason when the write fails", async () => {
    const drive = {
      readSmall: async () => null,
      put: async () => {
        throw new Error("disk full");
      },
    } as unknown as Drive;
    const [error] = await addRemovedPerson(drive, { key: A, log: () => {} });
    expect(error?.reason).toBe("disk full");
    expect(DRIVE_PATH_REMOVED).toBe("/removed-people.json");
  });
});
