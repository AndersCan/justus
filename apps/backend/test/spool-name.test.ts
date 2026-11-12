import { describe, it, expect } from "vite-plus/test";
import { parseSpoolName, spoolNameFor } from "../src/spool-name.ts";

describe("parseSpoolName", () => {
  it("reverses spoolNameFor", () => {
    expect(parseSpoolName(spoolNameFor("abc123", "p1", ".jpg"))).toEqual({
      driveKey: "abc123",
      id: "p1",
      ext: ".jpg",
    });
    expect(parseSpoolName(spoolNameFor("abc123", "p1", "thumb.jpg"))?.ext).toBe("thumb.jpg");
  });
  it("reads a .tmp leftover", () => {
    expect(parseSpoolName(`${spoolNameFor("k", "i", ".png")}.1700.ab12.tmp`)?.id).toBe("i");
  });
  it("is undefined for anything else", () => {
    expect(parseSpoolName("notes.txt")).toBeUndefined();
    expect(parseSpoolName("")).toBeUndefined();
    expect(parseSpoolName("../../x")).toBeUndefined();
  });
});
