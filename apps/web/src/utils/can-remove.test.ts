import { describe, expect, test } from "vite-plus/test";
import { canRemove, roleFor, whyNoDelete } from "./can-remove";

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

describe("roleFor", () => {
  const folders = [
    { id: "f1", role: "creator" as const },
    { id: "f2", role: "member" as const },
  ];
  test("an unknown album is a viewer", () => {
    expect(roleFor({ folderId: "nope" }, folders)).toBe("reader");
  });
  test("a known album gives its role", () => {
    expect(roleFor({ folderId: "f2" }, folders)).toBe("member");
  });
  test("the same id in another album does not match", () => {
    expect(roleFor({ folderId: "f1" }, folders)).toBe("creator");
    expect(roleFor({ folderId: "f1" }, [folders[1]])).toBe("reader");
  });
});

describe("whyNoDelete", () => {
  test("a viewer reads the viewer line", () => {
    expect(whyNoDelete({ mine: true }, { role: "reader" })).toBe("viewer");
  });
  test("a collaborator on someone else's photo reads the adder and Admin line", () => {
    expect(whyNoDelete({ mine: false }, { role: "member" })).toBe("adder_admin");
  });
  test("no line when the phone can delete", () => {
    expect(whyNoDelete({ mine: true }, { role: "member" })).toBeUndefined();
    expect(whyNoDelete({ mine: false }, { role: "creator" })).toBeUndefined();
  });
  test("no line in a removed album", () => {
    expect(
      whyNoDelete({ mine: false }, { role: "reader", notice: { kind: "removed" } }),
    ).toBeUndefined();
  });
  test("no line when the album is unknown", () => {
    expect(whyNoDelete({ mine: false }, undefined)).toBeUndefined();
  });
});
