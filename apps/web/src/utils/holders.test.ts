import { describe, expect, it } from "vite-plus/test";
import type { PhotoHolders } from "@justus/core";
import {
  deleteDetail,
  deletedMessage,
  hasFullPhoto,
  holdersLine,
  holdersSheetRows,
  lacksFullPhoto,
} from "./holders";

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
  it("only yours until others open it", () => {
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

describe("hasFullPhoto and lacksFullPhoto", () => {
  it("say nothing for no names", () => {
    expect(hasFullPhoto([])).toBe("");
    expect(lacksFullPhoto([])).toBe("");
  });
  it("agree with one name", () => {
    expect(hasFullPhoto(["Ben"])).toBe("Ben has the full photo.");
    expect(lacksFullPhoto(["Cy"])).toBe("Cy doesn't have the full photo.");
  });
  it("agree with two names", () => {
    expect(hasFullPhoto(["Ben", "Cy"])).toBe("Ben and Cy have the full photo.");
    expect(lacksFullPhoto(["Cy", "Dan"])).toBe("Cy and Dan don't have the full photo.");
  });
});

describe("deleteDetail", () => {
  const gone = "It will be gone from the album for everyone.";
  const back = "Deleting can't take it back.";
  it("says it is gone for everyone without holders", () => {
    expect(deleteDetail(undefined)).toBe(`${gone} ${back}`);
  });
  it("says only that it is gone when no one else has it", () => {
    expect(deleteDetail(h({ unsure: [m("Jo")], former: ["Al"] }))).toBe(`${gone} ${back}`);
  });
  it("names one phone", () => {
    expect(deleteDetail(h({ others: [m("Nils")] }))).toBe(
      `${gone} Nils has the full photo. It stops showing there, but Justus can't erase the copy already stored there. Deleting can't take it back.`,
    );
  });
  it("names two phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya")] }))).toBe(
      `${gone} Nils and Maya have the full photo. It stops showing there, but Justus can't erase the copies already stored there. Deleting can't take them back.`,
    );
  });
  it("names three phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya"), m("Ben")] }))).toBe(
      `${gone} Nils, Maya and Ben have the full photo. It stops showing there, but Justus can't erase the copies already stored there. Deleting can't take them back.`,
    );
  });
  it("names who has it and who does not", () => {
    expect(deleteDetail(h({ others: [m("Ben")], waiting: [m("Cy")] }))).toBe(
      `${gone} Ben has the full photo. It stops showing there, but Justus can't erase the copy already stored there. Cy doesn't have the full photo. Deleting can't take it back.`,
    );
  });
  it("names only who lacks it", () => {
    expect(deleteDetail(h({ waiting: [m("Ben")] }))).toBe(
      `${gone} Ben doesn't have the full photo. Deleting can't take it back.`,
    );
  });
});

describe("deletedMessage", () => {
  const person = (name: string, connected = true) => ({ key: name, name, connected });
  const people = [person("Ben"), person("Ana"), person("Cy"), person("Dan", false)];
  const rows: [string, Partial<PhotoHolders>, string][] = [
    ["alone", {}, "Deleted “Sunset”."],
    [
      "one keeps, one never got it",
      { others: [m("Ben")], waiting: [m("Cy")] },
      "Deleted “Sunset”. Ben has the full photo. Cy doesn't have the full photo.",
    ],
    [
      "two keep",
      { others: [m("Ana"), m("Ben")] },
      "Deleted “Sunset”. Ana and Ben have the full photo.",
    ],
    [
      "waiting away",
      { waiting: [m("Cy"), m("Dan")] },
      "Deleted “Sunset”. Cy and Dan don't have the full photo.",
    ],
    [
      "holder away",
      { others: [m("Ben"), m("Dan")] },
      "Deleted “Sunset”. Ben and Dan have the full photo. Dan will see it's gone when connected.",
    ],
    [
      "only unsure, former, left",
      { unsure: [m("Ben")], former: ["Eve"], left: ["Fay"] },
      "Deleted “Sunset”.",
    ],
  ];
  it.each(rows)("%s", (_, p, text) => {
    expect(deletedMessage("Sunset", h(p), people)).toBe(text);
  });
  it("without holders", () => {
    expect(deletedMessage("Sunset", undefined, people)).toBe("Deleted “Sunset”.");
  });
  it("uses the friend name, else the phone's own name", () => {
    const saved = [{ key: "k1", name: "Benny", connected: true }];
    const others = [
      { key: "k1", name: "Ben" },
      { key: "k2", name: "Zed" },
    ];
    expect(deletedMessage("Sunset", h({ others }), saved)).toBe(
      "Deleted “Sunset”. Benny and Zed have the full photo.",
    );
  });
});
