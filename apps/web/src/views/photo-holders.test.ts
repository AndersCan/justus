// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { render } from "lit-html";
import type { Photo, PhotoHolders } from "@justus/core";
import { holdersRow, holdersSheet } from "./photo-holders";

const m = (name: string) => ({ key: name, name });
function photo(holders: PhotoHolders | undefined): Photo {
  return {
    id: "a",
    url: "blob:a",
    name: "a",
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: m("M"),
    holders,
  };
}
const h = (p: Partial<PhotoHolders>): PhotoHolders => ({
  here: true,
  others: [],
  unsure: [],
  waiting: [],
  former: [],
  left: [],
  ...p,
});
const draw = (t: unknown) => {
  const el = document.createElement("div");
  render(t as never, el);
  return el;
};

describe("holdersRow", () => {
  it("is h-11 when tappable", () => {
    const el = draw(holdersRow(photo(h({}))));
    const b = el.querySelector("button");
    expect(b?.className).toContain("h-11");
    expect(b?.getAttribute("aria-label")).toBe("Only on your phone, show who has this photo");
  });
  it("is h-11 and not a button when it can't tell", () => {
    const el = draw(holdersRow(photo(undefined)));
    expect(el.querySelector("button")).toBeNull();
    expect(el.firstElementChild?.className).toContain("h-11");
    expect(el.textContent).toContain("Can't tell who has this photo yet");
  });
});

describe("holdersSheet", () => {
  it("lists You first and leaves out empty sections", () => {
    const el = draw(holdersSheet(photo(h({ others: [m("Nils")] }))));
    const names = [...el.querySelectorAll("li .text-fg")].map((n) => n.textContent);
    expect(names).toEqual(["You", "Nils"]);
    expect(el.textContent).not.toContain("Hasn't said yet");
    expect(el.textContent).not.toContain("Not on their phone yet");
    expect(el.textContent).not.toContain("No longer in this album");
    expect(el.textContent).not.toContain("Arriving…");
  });
  it("shows the unsure and former sections when they have rows", () => {
    const el = draw(holdersSheet(photo(h({ here: false, unsure: [m("Jo")], former: ["Ola"] }))));
    expect(el.textContent).toContain("Hasn't said yet");
    expect(el.textContent).toContain("No longer in this album");
    expect(el.textContent).toContain("Arriving…");
    expect(el.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Who has this photo",
    );
  });
});

describe("holdersSheet leavers", () => {
  it("says a leaver's phone deleted its copy", () => {
    const text = draw(holdersSheet(photo(h({ left: ["Cleo"] })))).textContent ?? "";
    expect(text).toContain("No longer in this album");
    expect(text).toContain("Cleo");
    expect(text).toContain("Their phone deleted its copy.");
    expect(text).not.toContain("Left.");
    expect(text).not.toContain("Has a copy from before");
  });
  it("lists removed people before leavers, each with its own text", () => {
    const text =
      draw(holdersSheet(photo(h({ former: ["Maya"], left: ["Cleo"] })))).textContent ?? "";
    expect(text.indexOf("Maya")).toBeLessThan(text.indexOf("Cleo"));
    expect(text).toContain("Has a copy from before");
    expect(text).toContain("Their phone deleted its copy.");
    expect(text).not.toContain("Left.");
  });
});

describe("holdersSheet waiting", () => {
  it("shows Not on their phone yet with names, above Hasn't said yet", () => {
    const el = draw(holdersSheet(photo(h({ waiting: [m("Maya")], unsure: [m("Jo")] }))));
    const text = el.textContent ?? "";
    expect(text).toContain("Maya");
    expect(text.indexOf("Not on their phone yet")).toBeGreaterThan(-1);
    expect(text.indexOf("Not on their phone yet")).toBeLessThan(text.indexOf("Hasn't said yet"));
  });
});

describe("holdersRow live region", () => {
  it("announces changes to the line politely", () => {
    const el = draw(holdersRow(photo(h({}))));
    expect(el.querySelector(".justus-holders-text")?.getAttribute("aria-live")).toBe("polite");
  });
});
