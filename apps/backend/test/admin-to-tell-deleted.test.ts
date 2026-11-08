import { describe, it, expect } from "vite-plus/test";
import { adminToTellDeleted } from "../src/photo-store.ts";

describe("adminToTellDeleted", () => {
  it("names the Admin for a removed phone", () => {
    expect(adminToTellDeleted({ notice: { kind: "removed" }, invite: { owner: "anna" } })).toBe(
      "anna",
    );
  });
  it("names nobody for a phone that was not removed", () => {
    expect(adminToTellDeleted({ invite: { owner: "anna" } })).toBeUndefined();
    expect(
      adminToTellDeleted({ notice: { kind: "deleted" }, invite: { owner: "anna" } }),
    ).toBeUndefined();
  });
  it("names nobody when the Admin is unknown", () => {
    expect(adminToTellDeleted({ notice: { kind: "removed" } })).toBeUndefined();
    expect(adminToTellDeleted({ notice: { kind: "removed" }, invite: {} })).toBeUndefined();
  });
});
