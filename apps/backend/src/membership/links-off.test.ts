import { describe, it, expect } from "vite-plus/test";
import * as nodeCrypto from "node:crypto";
import { inviteTopic } from "./invite";
import { linkOffId, linksOffFile, linksOffIn } from "./invites";

const crypto = nodeCrypto as unknown as typeof import("bare-crypto");

describe("links-off file", () => {
  it("round-trips ids, sorted", () => {
    expect(linksOffIn(linksOffFile(["b", "a"]))).toEqual(["a", "b"]);
  });

  it("reads nothing from a missing, garbled or odd file", () => {
    expect(linksOffIn(null)).toEqual([]);
    expect(linksOffIn("{")).toEqual([]);
    expect(linksOffIn("null")).toEqual([]);
    expect(linksOffIn('{"off":"x"}')).toEqual([]);
    expect(linksOffIn('{"off":["a",1,null]}')).toEqual(["a"]);
  });

  it("the id hides the code and matches no invite topic", () => {
    const code = "a".repeat(64);
    const id = linkOffId(code, crypto);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(code);
    expect(id).not.toBe(inviteTopic(code, crypto).toString("hex"));
    expect(linkOffId("b".repeat(64), crypto)).not.toBe(id);
  });
});
