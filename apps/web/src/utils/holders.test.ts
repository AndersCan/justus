import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { copy } from "../copy/copy";
import {
  deleteDetail,
  deletedMessage,
  hasFullPhoto,
  holdersLine,
  holdersSheetRows,
  lacksFullPhoto,
  memberHoldings,
  memberPhotosLine,
  previewOnly,
} from "./holders";

const m = (name: string) => ({ key: name, name });
const h = (p: Partial<PhotoHolders>): PhotoHolders => ({
  kind: "inAlbum",
  here: true,
  previewHere: false,
  others: [],
  quiet: [],
  unsure: [],
  waiting: [],
  previews: [],
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

  it("says only 'On your phone' for a removed phone, whatever it holds", () => {
    expect(holdersLine({ kind: "removed", here: true })).toEqual({
      text: "On your phone",
      tappable: true,
    });
    expect(holdersLine({ kind: "removed", here: false })).toEqual({
      text: "Arriving on your phone…",
      tappable: true,
    });
  });

  it("lists only this phone in the sheet of a removed phone", () => {
    const rows = {
      others: [],
      quiet: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    };
    expect(holdersSheetRows({ kind: "removed", here: true })).toEqual({
      youArriving: false,
      ...rows,
    });
    expect(holdersSheetRows({ kind: "removed", here: false })).toEqual({
      youArriving: true,
      ...rows,
    });
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
  it("names the friends a photo is on its way to, or counts them", () => {
    const line = (...names: string[]) => holdersLine(h({ waiting: names.map(m) })).text;
    expect(line("Ben")).toBe("On its way to Ben's phone");
    expect(line("Ben", "Cy")).toBe("On its way to Ben's and Cy's phones");
    expect(line("a", "b", "c", "d")).toBe("On its way to 4 phones");
    expect(line("Ben", "ben")).toBe("On its way to 2 phones");
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
  it("names one removed person who keeps a copy", () => {
    expect(holdersLine(h({ former: ["Ben"] })).text).toBe(
      "On your phone. Ben was removed and keeps a copy",
    );
    expect(holdersLine(h({ former: ["Ben"], unsure: [m("Jo")], waiting: [m("Nils")] })).text).toBe(
      "On your phone. Ben was removed and keeps a copy",
    );
  });
  it("a former holder with others, or several, keeps the count form", () => {
    expect(holdersLine(h({ former: ["A", "B"] })).text).toBe("On your phone and 2 others");
    expect(holdersLine(h({ left: ["Ben"] })).text).toBe("Only on your phone");
    expect(holdersLine(h({ others: [m("Nils")], former: ["Ola"] })).text).toBe(
      "On your phone and 2 others",
    );
  });
  it("counts the phones when two holders share a name", () => {
    const ben = (key: string, name = "Ben") => ({ key, name });
    expect(holdersLine(h({ others: [ben("k1"), ben("k2")] })).text).toBe(
      copy("holders.on_your_phone_and", { k: 2 }),
    );
    expect(holdersLine(h({ others: [ben("k1"), ben("k2", " ben")] })).text).toBe(
      copy("holders.on_your_phone_and", { k: 2 }),
    );
    expect(holdersLine(h({ others: [ben("k1"), ben("k2", "Cy")] })).text).toBe(
      "On Ben's, Cy's and your phone",
    );
    expect(holdersLine(h({ here: false, others: [ben("k1"), ben("k2")] })).text).toBe(
      copy("holders.on_arriving_on_yours", { k: 2 }),
    );
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

describe("holdersLine with a quiet phone", () => {
  const now = new Date(2026, 10, 18, 9, 0).getTime();
  const q = (name: string, lastSeenAt: number) => ({ key: name, name, lastSeenAt });
  const friday = new Date(2026, 10, 13, 20, 0).getTime();
  const nov9 = new Date(2026, 10, 9, 20, 0).getTime();

  it("names the day a quiet phone last had it, with this phone as the base", () => {
    expect(holdersLine(h({ quiet: [q("Ben", friday)] }), now).text).toBe(
      "On your phone. Ben's phone last had it Friday",
    );
    expect(holdersLine(h({ quiet: [q("Ben", nov9)] }), now).text).toBe(
      "On your phone. Ben's phone last had it November 9, 2026",
    );
  });

  it("keeps the fresh holders in the base", () => {
    expect(holdersLine(h({ others: [m("Ada")], quiet: [q("Ben", friday)] }), now).text).toBe(
      "On Ada's and your phone. Ben's phone last had it Friday",
    );
  });

  it("lists every quiet phone", () => {
    expect(holdersLine(h({ quiet: [q("Ben", friday), q("Cy", nov9)] }), now).text).toBe(
      "On your phone. Ben's phone last had it Friday, Cy's phone last had it November 9, 2026",
    );
  });

  it("keeps a removed-person line as the base", () => {
    expect(holdersLine(h({ former: ["Ola"], quiet: [q("Ben", friday)] }), now).text).toBe(
      "On your phone. Ola was removed and keeps a copy. Ben's phone last had it Friday",
    );
  });

  it("names a quiet phone while this phone is still waiting for its copy", () => {
    expect(holdersLine(h({ here: false, quiet: [q("Ben", friday)] }), now).text).toBe(
      copy("holders.line_and_quiet", {
        line: copy("holders.arriving_on_your_phone"),
        quiet: copy("holders.quiet_one_when", { name: "Ben's", when: "Friday" }),
      }),
    );
    expect(
      holdersLine(h({ here: false, others: [m("Ada")], quiet: [q("Ben", friday)] }), now).text,
    ).toContain("Ben's phone last had it Friday");
  });

  it("says the day from the clock it is given", () => {
    const later = new Date(2031, 0, 8, 9, 0).getTime();
    const monday = new Date(2031, 0, 6, 9, 0).getTime();
    expect(holdersLine(h({ quiet: [q("Ben", monday)] }), later).text).toBe(
      "On your phone. Ben's phone last had it Monday",
    );
  });

  it("keeps four fresh names as a count with the quiet phone after", () => {
    expect(
      holdersLine(h({ others: [m("A"), m("B"), m("C"), m("D")], quiet: [q("Cy", friday)] }), now)
        .text,
    ).toBe("On your phone and 4 others. Cy's phone last had it Friday");
  });

  it("is today's line with nobody quiet", () => {
    expect(holdersLine(h({ others: [m("Ada")] }), now).text).toBe("On Ada's and your phone");
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
  const back = "Copies saved outside Justus can't be taken back.";
  it("says it is gone for everyone without holders", () => {
    expect(deleteDetail(undefined)).toBe(`${gone} ${back}`);
  });
  it("says only that it is gone when no one else has it", () => {
    expect(deleteDetail(h({ unsure: [m("Jo")], left: ["Al"] }))).toBe(`${gone} ${back}`);
  });
  it("names one removed person who keeps a copy", () => {
    expect(deleteDetail(h({ former: ["Ben"] }))).toBe(
      `${gone} Ben was removed and keeps a copy on their phone. ${back}`,
    );
  });
  it("names no removed person when several", () => {
    expect(deleteDetail(h({ former: ["Ben", "Cy"] }))).toBe(`${gone} ${back}`);
  });
  it("names one phone", () => {
    expect(deleteDetail(h({ others: [m("Nils")] }))).toBe(
      `${gone} Nils's phone stops showing it and drops its copy once it's connected. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("names two phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya")] }))).toBe(
      `${gone} Nils's and Maya's phones stop showing it and drop their copies once they're connected. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("names three phones", () => {
    expect(deleteDetail(h({ others: [m("Nils"), m("Maya"), m("Ben")] }))).toBe(
      `${gone} Nils's, Maya's and Ben's phones stop showing it and drop their copies once they're connected. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("names who has it and who does not", () => {
    expect(deleteDetail(h({ others: [m("Ben")], waiting: [m("Cy")] }))).toBe(
      `${gone} Ben's phone stops showing it and drops its copy once it's connected. Cy doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("names only who lacks it", () => {
    expect(deleteDetail(h({ waiting: [m("Ben")] }))).toBe(
      `${gone} Ben doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
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
  it("names a person with only a preview by the friend name", () => {
    const saved = [{ key: "k1", name: "Benny", connected: true }];
    expect(deletedMessage("Sunset", h({ previews: [{ key: "k1", name: "Ben" }] }), saved)).toBe(
      "Deleted “Sunset”. The photo no longer shows for Benny.",
    );
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

describe("previews", () => {
  const gone = "It will be gone from the album for everyone.";
  it("previewOnly names who only has a preview", () => {
    expect(previewOnly([])).toBe("");
    expect(previewOnly(["Ben"])).toBe("The photo no longer shows for Ben.");
    expect(previewOnly(["Ben", "Cy"])).toBe("The photo no longer shows for Ben and Cy.");
  });
  it("the dialog says who only has a preview", () => {
    expect(deleteDetail(h({ previews: [m("Ben")] }))).toBe(
      `${gone} Ben's phone stops showing it and drops its copy once it's connected. Copies saved outside Justus can't be taken back.`,
    );
    expect(deleteDetail(h({ others: [m("Ben")], previews: [m("Cy")], waiting: [m("Dan")] }))).toBe(
      `${gone} Ben's and Cy's phones stop showing it and drop their copies once they're connected. Dan doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("the toast says who only has a preview, and who finds out when connected", () => {
    const people = [
      { key: "Ben", name: "Ben", connected: true },
      { key: "Cara", name: "Cara", connected: false },
    ];
    expect(deletedMessage("pixel-2.png", h({ previews: [m("Ben")] }), people)).toBe(
      "Deleted “pixel-2.png”. The photo no longer shows for Ben.",
    );
    expect(deletedMessage("b", h({ previews: [m("Cara")] }), people)).toBe(
      "Deleted “b”. The photo no longer shows for Cara. Cara will see it's gone when connected.",
    );
  });
  it.each([
    [{ previews: [m("Ben")] }, "On your phone. Preview on Ben's phone"],
    [{ previews: [m("Ben"), m("Cy")] }, "On your phone. Preview on Ben's and Cy's phones"],
    [
      { others: [m("Nils")], previews: [m("Cy")] },
      "On Nils's and your phone. Preview on Cy's phone",
    ],
    [{ previews: [m("Ben"), m("Cy"), m("Jo")] }, "On your phone. Preview on 3 phones"],
    [
      {
        previews: [
          { key: "k1", name: "Ben" },
          { key: "k2", name: "Ben" },
        ],
      },
      "On your phone. Preview on 2 phones",
    ],
    [{ previews: [m("a"), m("b"), m("c"), m("d")] }, "On your phone. Preview on 4 phones"],
  ])("a preview names its phone: %j", (p, text) => {
    expect(holdersLine(h(p), 0).text).toBe(text);
  });
  it("sheet rows carry previews", () => {
    expect(holdersSheetRows(h({ previews: [m("Ben")] })).previews).toEqual([m("Ben")]);
    expect(holdersSheetRows(undefined).previews).toEqual([]);
  });
});

describe("a removed phone", () => {
  it("has nothing to say about others in the delete texts", () => {
    const removed: PhotoHolders = { kind: "removed", here: true };
    expect(deleteDetail(removed)).toBe(deleteDetail(undefined));
    expect(deletedMessage("a.jpg", removed, [])).toBe(deletedMessage("a.jpg", undefined, []));
  });
});

describe("a quiet phone in the delete dialog and toast", () => {
  const q = (name: string) => ({ key: name, name, lastSeenAt: 1 });
  it("still names the phone as having the full photo, after the fresh ones", () => {
    const holders = h({ others: [m("Cy")], quiet: [q("Ben")] });
    expect(deleteDetail(holders)).toBe(deleteDetail(h({ others: [m("Cy"), m("Ben")] })));
    expect(deleteDetail(holders)).toContain("Cy's and Ben's phones stop showing it");
  });
  it("tells a quiet phone that is not connected it will see the photo gone", () => {
    const people = [{ key: "Ben", name: "Ben", connected: false }];
    expect(deletedMessage("a", h({ quiet: [q("Ben")] }), people)).toBe(
      deletedMessage("a", h({ others: [m("Ben")] }), people),
    );
    expect(deletedMessage("a", h({ quiet: [q("Ben")] }), people)).toContain(
      "Ben will see it's gone when connected.",
    );
  });
  it("passes quiet through to the sheet rows", () => {
    expect(holdersSheetRows(h({ quiet: [q("Ben")] })).quiet).toEqual([q("Ben")]);
    expect(holdersSheetRows(undefined).quiet).toEqual([]);
  });
});

describe("memberHoldings", () => {
  const photoWith = (holders: PhotoHolders | undefined) =>
    ({ id: "p", holders }) as unknown as Photo;
  const q = (name: string) => ({ ...m(name), lastSeenAt: 1 });
  const people = ["Ada", "Ben", "Cy", "Dan", "Eve", "Fay"].map((key, i) => ({ key, you: i === 0 }));

  it("counts each member from the sheet's lists", () => {
    const rest = { quiet: [q("Cy")], unsure: [m("Dan")], waiting: [m("Eve")] };
    const photos = [
      photoWith(h({ others: [m("Ben")], ...rest })),
      photoWith(h({ previews: [m("Ben")], ...rest })),
      photoWith(h({ here: false, previewHere: true, previews: [m("Ben")], ...rest })),
    ];
    const got = memberHoldings(photos, people);
    expect(got.get("Ada")).toEqual({ full: 2, previews: 1, total: 3 });
    expect(got.get("Ben")).toEqual({ full: 1, previews: 2, total: 3 });
    expect(got.get("Eve")).toEqual({ full: 0, previews: 0, total: 3 });
    expect([...got.keys()]).toEqual(["Ada", "Ben", "Eve"]);
  });

  it("counts your own phone even when it holds neither copy", () => {
    const photos = [photoWith(h({ here: false })), photoWith(h({}))];
    expect(memberHoldings(photos, people).get("Ada")).toEqual({ full: 1, previews: 0, total: 2 });
  });

  it("says nothing until every photo's holders are known", () => {
    expect(memberHoldings([], people).size).toBe(0);
    expect(memberHoldings([photoWith(h({})), photoWith(undefined)], people).size).toBe(0);
    expect(
      memberHoldings([photoWith(h({})), photoWith({ kind: "removed", here: true })], people).size,
    ).toBe(0);
  });
});

describe("memberPhotosLine", () => {
  it("words the line", () => {
    expect(memberPhotosLine(undefined)).toBe("");
    expect(memberPhotosLine({ full: 3, previews: 0, total: 3 })).toBe("Photos: 3 of 3");
    expect(memberPhotosLine({ full: 1, previews: 2, total: 3 })).toBe(
      "Photos: 1 of 3, 2 as previews",
    );
  });
});
