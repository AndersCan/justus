// @vitest-environment happy-dom
import { describe, expect, test } from "vite-plus/test";
import { render } from "lit-html";
import { copy } from "../copy/copy";
import { stillToDropLine, stillToDropParams } from "./still-to-drop";

const member = (key: string, name: string, connected: boolean, stillToDrop?: string[]) => ({
  key,
  name,
  admin: false,
  connected,
  ...(stillToDrop && { stillToDrop }),
});
const statusOf = (...members: ReturnType<typeof member>[]) =>
  ({ folder: { id: "f1" }, members: [member("me", "Ada", true), ...members] }) as never;
const text = (status: never) => {
  const host = document.createElement("div");
  render(stillToDropLine(status), host);
  return host.textContent?.replace(/\s+/g, " ").trim();
};

describe("stillToDropLine", () => {
  test("one person, one photo: the release sentence", () => {
    expect(text(statusOf(member("k1", "Ben", false, ["p1"])))).toBe(
      "Ben's phone still has a deleted photo. It drops it when it connects.",
    );
  });

  test("two people sharing one photo", () => {
    expect(
      text(statusOf(member("k1", "Ben", false, ["p1"]), member("k2", "Cy", false, ["p1"]))),
    ).toBe("Ben's and Cy's phones still have a deleted photo. They drop it when they connect.");
  });

  test("one person with three photos", () => {
    expect(text(statusOf(member("k1", "Ben", false, ["p1", "p2", "p3"])))).toBe(
      "Ben's phone still has deleted photos. It drops them when it connects.",
    );
  });

  test("a connected person is not named; with all connected there is no line", () => {
    const some = statusOf(member("k1", "Ben", false, ["p1"]), member("k2", "Cy", true, ["p1"]));
    expect(stillToDropParams(some)?.list).toBe("Ben's");
    expect(stillToDropLine(statusOf(member("k2", "Cy", true, ["p1"])))).toBeNull();
  });

  test("an empty name reads Unknown device", () => {
    expect(stillToDropParams(statusOf(member("k1", "", false, ["p1"])))?.list).toBe(
      `${copy("people.unknown_device")}'s`,
    );
  });

  test("no field or an empty one gives no line", () => {
    expect(stillToDropLine(statusOf(member("k1", "Ben", false)))).toBeNull();
    expect(stillToDropLine(statusOf(member("k1", "Ben", false, [])))).toBeNull();
  });

  test("this phone's own row is never named", () => {
    const status = {
      folder: { id: "f1" },
      members: [member("me", "Ada", false, ["p1"])],
    } as never;
    expect(stillToDropLine(status)).toBeNull();
  });
});
