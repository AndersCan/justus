import { describe, it, expect } from "vite-plus/test";
import { askAnswer, changeCause } from "./handle-message";

describe("changeCause", () => {
  it("reads the cause from a dispatch header", () => {
    expect(changeCause({ args: { cause: "presence" } })).toBe("presence");
  });

  it("ignores headers without one", () => {
    expect(changeCause({})).toBeUndefined();
    expect(changeCause({ args: { cause: 3 } })).toBeUndefined();
  });
});

describe("askAnswer", () => {
  it("reads an accepted answer with its album", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "accepted", folderId: "f" })).toEqual({
      code: "c",
      answer: "accepted",
      folderId: "f",
    });
  });
  it("reads a declined answer without a folder", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "declined" })).toEqual({
      code: "c",
      answer: "declined",
      folderId: undefined,
    });
  });
  it.each([
    undefined,
    { cause: "add", code: "c", answer: "accepted" },
    { cause: "ask", answer: "accepted" },
    { cause: "ask", code: "c" },
    { cause: "ask", code: "c", answer: "maybe" },
  ])("ignores %j", (args) => {
    expect(askAnswer(args)).toBeUndefined();
  });
});
