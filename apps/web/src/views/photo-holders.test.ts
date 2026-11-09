// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { render } from "lit-html";
import type { Photo, PhotoHolders } from "@justus/core";
import { holdersRow, holdersSheet } from "./photo-holders";
import { memberColor } from "../utils/palette";
import type { Person } from "../utils/people";

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
  it("is min-h-11 when tappable", () => {
    const el = draw(holdersRow(photo(h({}))));
    const b = el.querySelector("button");
    expect(b?.className).toContain("min-h-11");
    expect(b?.getAttribute("aria-label")).toBe("Only on your phone, show who has this photo");
  });
  it("wraps long text instead of cutting it", () => {
    const el = draw(holdersRow(photo(h({ waiting: [m("Nils")] }))));
    const text = el.querySelector(".justus-holders-text");
    expect(text?.textContent).toContain("On its way to the people you let in");
    expect(text?.className).not.toContain("truncate");
  });
  it("is min-h-11 and not a button when it can't tell", () => {
    const el = draw(holdersRow(photo(undefined)));
    expect(el.querySelector("button")).toBeNull();
    expect(el.firstElementChild?.className).toContain("min-h-11");
    expect(el.textContent).toContain("Can't tell who has this photo yet");
  });
});

describe("holdersSheet", () => {
  it("lists You first and leaves out empty sections", () => {
    const el = draw(holdersSheet(photo(h({ others: [m("Nils")] })), []));
    const names = [...el.querySelectorAll("li .text-fg")].map((n) => n.textContent);
    expect(names).toEqual(["You", "Nils"]);
    expect(el.textContent).not.toContain("Hasn't said yet");
    expect(el.textContent).not.toContain("Not on their phone yet");
    expect(el.textContent).not.toContain("No longer in this album");
    expect(el.textContent).not.toContain("Arriving…");
  });
  it("shows the unsure and former sections when they have rows", () => {
    const el = draw(
      holdersSheet(photo(h({ here: false, unsure: [m("Jo")], former: ["Ola"] })), []),
    );
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
    const text = draw(holdersSheet(photo(h({ left: ["Cleo"] })), [])).textContent ?? "";
    expect(text).toContain("No longer in this album");
    expect(text).toContain("Cleo");
    expect(text).toContain("Their phone deleted its copy.");
    expect(text).not.toContain("Left.");
    expect(text).not.toContain("Has a copy from before");
  });
  it("lists removed people before leavers, each with its own text", () => {
    const text =
      draw(holdersSheet(photo(h({ former: ["Maya"], left: ["Cleo"] })), [])).textContent ?? "";
    expect(text.indexOf("Maya")).toBeLessThan(text.indexOf("Cleo"));
    expect(text).toContain("Has a copy from before");
    expect(text).toContain("Their phone deleted its copy.");
    expect(text).not.toContain("Left.");
  });
});

describe("holdersSheet waiting", () => {
  it("names the phones a waiting friend gets the photo from, above Hasn't said yet", () => {
    const el = draw(holdersSheet(photo(h({ waiting: [m("Maya")], unsure: [m("Jo")] })), []));
    const text = el.textContent ?? "";
    expect(text).toContain("Maya");
    expect(text).not.toContain("Not on their phone yet");
    expect(text.indexOf("Can still get it from you")).toBeGreaterThan(-1);
    expect(text.indexOf("Can still get it from you")).toBeLessThan(text.indexOf("Hasn't said yet"));
  });
  it("on a waiting phone, lists the holders and moves You under the heading", () => {
    const el = draw(holdersSheet(photo(h({ here: false, others: [m("Ada"), m("Ben")] })), []));
    const heading = el.querySelector("h4");
    expect(heading?.textContent?.trim()).toBe("Can still get it from Ada and Ben");
    const lists = el.querySelectorAll("ul");
    expect([...lists[0].querySelectorAll(".text-fg")].map((n) => n.textContent)).toEqual([
      "Ada",
      "Ben",
    ]);
    expect(lists[1].textContent).toContain("You");
    expect(lists[1].textContent).toContain("Arriving…");
    expect(el.querySelector('[data-copy-id="photo_holders.can_still_get_it_from"]')).not.toBeNull();
  });
  it("puts you last in the list of sources", () => {
    const el = draw(
      holdersSheet(photo(h({ here: true, others: [m("Ben")], waiting: [m("Cy")] })), []),
    );
    expect(el.querySelector("h4")?.textContent?.trim()).toBe("Can still get it from Ben and you");
  });
  it("claims no source when nobody holds a copy", () => {
    const el = draw(holdersSheet(photo(h({ here: false, others: [] })), []));
    expect(el.querySelector("h4")?.textContent?.trim()).toBe("Not on their phone yet");
  });
});

describe("holdersRow live region", () => {
  it("announces changes to the line politely", () => {
    const el = draw(holdersRow(photo(h({}))));
    expect(el.querySelector(".justus-holders-text")?.getAttribute("aria-live")).toBe("polite");
  });
});

const person = (key: string, name: string, color: number, you = false) =>
  ({ key, name, color, you }) as Person;
const people = [person("k0", "Ben", 0, true), person("k1", "Mum", 1), person("k2", "Cy", 2)];
const fillOf = (li: Element) => li.querySelector("span[style]")?.getAttribute("style");
const initialsOfRow = (li: Element) => li.querySelector("span[aria-hidden]")?.textContent;

describe("holdersSheet colours", () => {
  it("shows a keyed row with its Members name, initials and colour", () => {
    const el = draw(holdersSheet(photo(h({ others: [{ key: "k1", name: "Ada" }] })), people));
    const row = el.querySelectorAll("li")[1];
    expect(row.querySelector(".text-fg")?.textContent).toBe("Mum");
    expect(initialsOfRow(row)).toBe("MU");
    expect(fillOf(row)).toBe(`background:${memberColor(1)}`);
  });
  it("shows your own row as You with your initials and colour, here or arriving", () => {
    const here = draw(holdersSheet(photo(h({})), people)).querySelector("li")!;
    expect(here.querySelector(".text-fg")?.textContent).toBe("You");
    expect(initialsOfRow(here)).toBe("BE");
    expect(fillOf(here)).toBe(`background:${memberColor(0)}`);
    const arriving = draw(
      holdersSheet(photo(h({ here: false, waiting: [{ key: "k2", name: "Cy" }] })), people),
    ).querySelectorAll("li");
    expect(initialsOfRow(arriving[0])).toBe("BE");
    expect(fillOf(arriving[0])).toBe(`background:${memberColor(0)}`);
    expect(fillOf(arriving[1])).toBe(`background:${memberColor(2)}`);
  });
  it("shows a key that is not on Members, and former people, outlined", () => {
    const el = draw(
      holdersSheet(
        photo(h({ unsure: [{ key: "k9", name: "Old phone" }], former: ["Ola"] })),
        people,
      ),
    );
    const rows = [...el.querySelectorAll("li")];
    expect(fillOf(rows[1])).toBeUndefined();
    expect(fillOf(rows[2])).toBeUndefined();
    expect(rows[2].querySelector("span[aria-hidden]")?.className).toContain("ring-line");
  });
  it("shows a hasn't-said-yet keyed row with its Members name and colour", () => {
    const el = draw(holdersSheet(photo(h({ unsure: [{ key: "k2", name: "Old" }] })), people));
    const row = el.querySelectorAll("li")[1];
    expect(row.querySelector(".text-fg")?.textContent).toBe("Cy");
    expect(fillOf(row)).toBe(`background:${memberColor(2)}`);
  });
  it("shows a left name outlined", () => {
    const el = draw(holdersSheet(photo(h({ left: ["Cleo"] })), people));
    const row = el.querySelectorAll("li")[1];
    expect(row.querySelector(".text-fg")?.textContent).toBe("Cleo");
    expect(fillOf(row)).toBeUndefined();
  });
  it("names Members' name in the Can still get it from heading", () => {
    const el = draw(
      holdersSheet(photo(h({ others: [{ key: "k1", name: "Ada" }], waiting: [m("Cy")] })), people),
    );
    expect(el.querySelector("h4")?.textContent?.trim()).toBe("Can still get it from Mum and you");
  });
  it("says the new subtitle once, above the first list", () => {
    const el = draw(holdersSheet(photo(h({ others: [m("Nils")], former: ["Ola"] })), people));
    const text = "Phones that have it, as of when they last connected.";
    expect(el.textContent?.split(text).length).toBe(2);
    const sub = [...el.querySelectorAll("p")].find((x) => x.textContent === text)!;
    expect(sub.compareDocumentPosition(el.querySelector("ul")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("holdersSheet without Members", () => {
  it("shows your own row as You outlined when you are not in people", () => {
    const row = draw(holdersSheet(photo(h({})), [])).querySelector("li")!;
    expect(row.querySelector(".text-fg")?.textContent).toBe("You");
    expect(fillOf(row)).toBeUndefined();
  });
});
