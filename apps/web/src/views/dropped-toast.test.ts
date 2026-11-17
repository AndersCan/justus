import { describe, expect, it, vi } from "vite-plus/test";
import { droppedText, droppedToast } from "./dropped-toast";
import { toast } from "./toast";

vi.mock("./toast", () => ({ toast: vi.fn() }));

describe("droppedText", () => {
  it.each([
    [["Ben"], "Removed from Ben's phone."],
    [["Ben", "Cy"], "Removed from Ben's and Cy's phones."],
    [["Ben", "Cy", "Dan"], "Removed from Ben's, Cy's and Dan's phones."],
    [[], ""],
  ])("%j", (names, text) => {
    expect(
      droppedText({ folderId: "f1", people: names.map((name) => ({ key: name, name })) }),
    ).toBe(text);
  });
});

describe("droppedToast", () => {
  it("shows the text, and nothing for no names", () => {
    droppedToast.show({ folderId: "f1", people: [] });
    expect(toast).not.toHaveBeenCalled();
    droppedToast.show({ folderId: "f1", people: [{ key: "k", name: "Ben" }] });
    expect(toast).toHaveBeenCalledWith("Removed from Ben's phone.");
  });
});
