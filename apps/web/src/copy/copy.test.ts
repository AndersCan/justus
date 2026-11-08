import { describe, expect, it } from "vite-plus/test";
import en from "./en.json";
import { copy, fill, t } from "./copy";

describe("fill", () => {
  it("replaces named params", () => {
    expect(fill("Hello {name}, {name}!", { name: "Ada" })).toBe("Hello Ada, Ada!");
  });

  it("writes the one form for 1 and the other form otherwise", () => {
    const text = "{n} photo{n?:s}";
    expect(fill(text, { n: 1 })).toBe("1 photo");
    expect(fill(text, { n: 0 })).toBe("0 photos");
    expect(fill(text, { n: 2 })).toBe("2 photos");
  });

  it("takes words on both sides of a plural", () => {
    expect(fill("{n?That photo is:Those photos are} here", { n: 1 })).toBe("That photo is here");
    expect(fill("{n?That photo is:Those photos are} here", { n: 3 })).toBe("Those photos are here");
  });

  it("leaves a placeholder without a param as written", () => {
    expect(fill("Hi {name}", {})).toBe("Hi {name}");
  });

  it("does not touch text without placeholders", () => {
    expect(fill("Skip")).toBe("Skip");
  });
});

describe("copy and t", () => {
  const id = "welcome.skip" as const;

  it("returns the catalogue text", () => {
    expect(copy(id)).toBe(en[id].text);
  });

  it("marks the element with its id, and draft text in dev", () => {
    const entry = en[id] as { status: string };
    const before = entry.status;
    entry.status = "draft";
    try {
      const [markId, draft, text] = t(id).values;
      expect(markId).toBe(id);
      expect(draft).toBe("");
      expect(text).toBe(en[id].text);
    } finally {
      entry.status = before;
    }
  });

  it("does not mark approved text as a draft", () => {
    const entry = en[id] as { status: string };
    const before = entry.status;
    entry.status = "approved";
    try {
      expect(t(id).values[1]).not.toBe("");
    } finally {
      entry.status = before;
    }
  });
});
