import { describe, expect, it } from "vite-plus/test";
import type { PhotoHolders } from "@justus/core";
import { deleteDetail, holdersLine, holdersSheetRows } from "./holders";

const m = (name: string) => ({ key: name, name });
const h = (p: Partial<PhotoHolders>): PhotoHolders => ({
  here: true,
  others: [],
  unsure: [],
  waiting: [],
  former: [],
  left: [],
  ...p,
});

describe("holdersLine", () => {
  it("does not count a leaver as a holder", () => {
    expect(holdersLine(h({ left: ["Cleo"] })).text).toBe("Only on your phone");
    expect(holdersLine(h({ others: [m("Nils")], left: ["Cleo"] })).text).toBe(
      "On Nils's and your phone",
    );
  });

  it("can't tell without holders, and is not tappable", () => {
    expect(holdersLine(undefined)).toEqual({
      text: "Can't tell who has this photo yet",
      tappable: false,
    });
  });
  it("only on your phone", () => {
    expect(holdersLine(h({}))).toEqual({ text: "Only on your phone", tappable: true });
  });
  it("on its way to the people you let in when others can get it", () => {
    expect(holdersLine(h({ waiting: [m("Nils")] })).text).toBe(
      "On its way to the people you let in",
    );
  });
  it("others haven't said wins over so far", () => {
    expect(holdersLine(h({ unsure: [m("Jo")], waiting: [m("Nils")] })).text).toBe(
      "On your phone. Others haven't said",
    );
  });
  it("a named holder line ignores waiting", () => {
    expect(holdersLine(h({ others: [m("Nils")], waiting: [m("Maya")] })).text).toBe(
      "On Nils's and your phone",
    );
  });
  it("sheet rows carry waiting", () => {
    expect(holdersSheetRows(h({ waiting: [m("Maya")] })).waiting).toEqual([m("Maya")]);
    expect(holdersSheetRows(undefined).waiting).toEqual([]);
  });
  it("others haven't said", () => {
    expect(holdersLine(h({ unsure: [m("Jo")] })).text).toBe("On your phone. Others haven't said");
  });
  it("names one or two others, you last", () => {
    expect(holdersLine(h({ others: [m("Nils")] })).text).toBe("On Nils's and your phone");
    expect(holdersLine(h({ others: [m("Nils"), m("Maya")] })).text).toBe(
      "On Nils's, Maya's and your phone",
    );
  });
  it("keeps a named form of exactly 36 characters", () => {
    const text = holdersLine(h({ others: [m("Nils"), m("Mia"), m("J")] })).text;
    expect(text).toBe("On Nils's, Mia's, J's and your phone");
    expect(text.length).toBe(36);
  });
  it("falls back to a count past 36 characters", () => {
    expect(holdersLine(h({ others: [m("Nils"), m("Maya"), m("Jo")] })).text).toBe(
      "On your phone and 3 others",
    );
  });
  it("counts four or more", () => {
    expect(holdersLine(h({ others: [m("a"), m("b"), m("c"), m("d")] })).text).toBe(
      "On your phone and 4 others",
    );
  });
  it("a former holder forces the count form", () => {
    expect(holdersLine(h({ others: [m("Nils")], former: ["Ola"] })).text).toBe(
      "On your phone and 2 others",
    );
    expect(holdersLine(h({ former: ["Ola"] })).text).toBe("On your phone and 1 other");
  });
  it("not here: one named other, else counts", () => {
    expect(holdersLine(h({ here: false, others: [m("Maya")] })).text).toBe(
      "On Maya's phone. Arriving on yours…",
    );
    expect(holdersLine(h({ here: false, others: [m("A very long name indeed")] })).text).toBe(
      "On 1 phone. Arriving on yours…",
    );
    expect(holdersLine(h({ here: false, others: [m("a"), m("b")] })).text).toBe(
      "On 2 phones. Arriving on yours…",
    );
    expect(holdersLine(h({ here: false, others: [m("a")], former: ["z"] })).text).toBe(
      "On 2 phones. Arriving on yours…",
    );
  });
  it("not here and nobody else", () => {
    expect(holdersLine(h({ here: false })).text).toBe("Arriving on your phone…");
  });
});

describe("holdersSheetRows", () => {
  it("you are arriving only when not here", () => {
    expect(holdersSheetRows(h({ here: false })).youArriving).toBe(true);
    expect(holdersSheetRows(h({})).youArriving).toBe(false);
  });
  it("passes the sections through", () => {
    const rows = holdersSheetRows(h({ others: [m("a")], unsure: [m("b")], former: ["c"] }));
    expect(rows.others).toEqual([m("a")]);
    expect(rows.unsure).toEqual([m("b")]);
    expect(rows.former).toEqual(["c"]);
    expect(holdersSheetRows(h({ left: ["Cleo"] })).left).toEqual(["Cleo"]);
    expect(holdersSheetRows(undefined).left).toEqual([]);
  });
});

describe("deleteDetail", () => {
  const gone = "It will be gone from the album for everyone.";
  it("says only that it is gone without holders", () => {
    expect(deleteDetail(undefined)).toBe(gone);
  });
  it("says only that it is gone when no one else has it", () => {
    expect(deleteDetail(h({ unsure: [m("Jo")], former: ["Al"] }))).toBe(gone);
  });
  it("names one phone", () => {
    expect(deleteDetail(h({ others: [m("Nils")] }))).toBe(
      `${gone} Nils's phone keeps a copy. Deleting can't take it back.`,
    );
  });
  it("names two phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya")] }))).toBe(
      `${gone} Nils's and Maya's phones keep a copy. Deleting can't take them back.`,
    );
  });
  it("names three phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya"), m("Ben")] }))).toBe(
      `${gone} Nils's, Maya's and Ben's phones keep a copy. Deleting can't take them back.`,
    );
  });
});
