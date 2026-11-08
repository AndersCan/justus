import { describe, expect, test, vi } from "vite-plus/test";
import type { JoinRequest } from "@justus/core";
import { parsePath } from "../machines/router-machine";
import { askToast } from "./ask-toast";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const ask = (name: string, folderId = "f1", identity?: string) =>
  ({
    folderId,
    folderName: "Spain",
    requesterKey: `k-${name}`,
    requesterName: name,
    requesterIdentity: identity,
  }) as unknown as JoinRequest;

const photos = parsePath("/");

describe("askToast", () => {
  test("one ask on Photos names her and opens her album", () => {
    expect(askToast([ask("Maya")], photos, {})).toEqual({
      text: "Maya wants to join “Spain”",
      path: "/sharing/f1",
    });
  });

  test("the path encodes the folder id", () => {
    expect(askToast([ask("Maya", "a/b")], photos, {})?.path).toBe("/sharing/a%2Fb");
  });

  test("nothing for the album on screen, shown for another", () => {
    expect(askToast([ask("Maya")], parsePath("/sharing/f1"), {})).toBeUndefined();
    expect(askToast([ask("Maya")], parsePath("/sharing/f2"), {})?.text).toBe(
      "Maya wants to join “Spain”",
    );
  });

  test("a photo album page with the same id does not hide the ask", () => {
    expect(askToast([ask("Maya")], parsePath("/albums/f1"), {})?.text).toBe(
      "Maya wants to join “Spain”",
    );
  });

  test("an empty list shows nothing", () => {
    expect(askToast([], photos, {})).toBeUndefined();
  });

  test("a saved friend is named by the saved name", () => {
    expect(askToast([ask("Maya", "f1", "i-maya")], photos, { "i-maya": "Mum" })?.text).toBe(
      "Mum wants to join “Spain”",
    );
  });

  test("a stranger typing a friend's name is not named", () => {
    expect(askToast([ask("Mum", "f1", "i-other")], photos, { "i-maya": "Mum" })?.text).toBe(
      "Someone not in your friends wants to join “Spain”",
    );
  });

  test("several asks are counted and open the Sharing tab", () => {
    expect(askToast([ask("A"), ask("B", "f2"), ask("C")], photos, {})).toEqual({
      text: "3 people want to join",
      path: "/sharing",
    });
  });

  test("two asks are already a count", () => {
    expect(askToast([ask("A"), ask("B")], photos, {})?.text).toBe("2 people want to join");
  });

  test("with one album on screen, the rest decide the wording", () => {
    expect(askToast([ask("A"), ask("B", "f2")], parsePath("/sharing/f1"), {})).toEqual({
      text: "B wants to join “Spain”",
      path: "/sharing/f2",
    });
  });
});
