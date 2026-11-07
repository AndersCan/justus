import { describe, expect, test } from "vite-plus/test";
import { canRemove, roleFor } from "./can-remove";

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
