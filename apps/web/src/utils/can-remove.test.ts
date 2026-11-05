import { describe, expect, test } from "vite-plus/test";
import { canRemove, removeDetail } from "./can-remove";

describe("canRemove", () => {
  test("Admin removes any photo", () => {
    expect(canRemove({ mine: true }, "creator")).toBe(true);
    expect(canRemove({ mine: false }, "creator")).toBe(true);
    expect(canRemove({}, "creator")).toBe(true);
  });
  test("a collaborator removes only their own", () => {
    expect(canRemove({ mine: true }, "member")).toBe(true);
    expect(canRemove({ mine: false }, "member")).toBe(false);
    expect(canRemove({}, "member")).toBe(false);
  });
  test("a viewer removes nothing", () => {
    expect(canRemove({ mine: true }, "reader")).toBe(false);
    expect(canRemove({ mine: false }, "reader")).toBe(false);
  });
});

describe("removeDetail", () => {
  test("own photo", () => {
    expect(removeDetail({ mine: true, member: { key: "k", name: "Ann" } })).toBe(
      "Removes it from the album for everyone. Phones that already have it may keep a copy.",
    );
  });
  test("someone else's photo names them", () => {
    expect(removeDetail({ mine: false, member: { key: "k", name: "Maya" } })).toBe(
      "Hides it from the album for everyone. It stays on Maya's phone.",
    );
  });
});
