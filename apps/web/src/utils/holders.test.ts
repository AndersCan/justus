import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { copy } from "../copy/copy";
import {
  deleteDetail,
  deletedMessage,
  hasFullPhoto,
  holdersLine as holdersLineAt,
  holdersSheetRows,
  leaverHolders,
  lacksFullPhoto,
  memberHoldings,
  memberKeeps,
  memberPhotosLine,
  previewOnly,
} from "./holders";

const m = (name: string) => ({ key: name, name, connected: true });
const NOW = 1_000_000;
const holdersLine = (x: PhotoHolders | undefined, now = NOW) => holdersLineAt(x, now);
const w = (name: string, connected = true) => ({ key: name, name, connected });
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

  describe("a friend whose phone is off", () => {
    const off = (name: string) => ({ key: name, name, connected: false, lastSeenAt: NOW - 60_000 });
    const blip = (name: string) => ({
      key: name,
      name,
      connected: false,
      lastSeenAt: NOW - 10_000,
    });
    const never = (name: string) => ({ key: name, name, connected: false });
    const rows: [string, Partial<PhotoHolders>, string][] = [
      ["off", { waiting: [off("Ben")] }, "On your phone. Waiting for Ben's phone"],
      ["on", { waiting: [w("Ben")] }, "On your phone. On its way to Ben's phone"],
      ["a blip", { waiting: [blip("Ben")] }, "On your phone. On its way to Ben's phone"],
      ["never seen", { waiting: [never("Ben")] }, "On your phone. Waiting for Ben's phone"],
      [
        "previews and off",
        { previews: [m("Cy")], waiting: [off("Ben")] },
        "On your phone. Preview on Cy's phone. Waiting for Ben's phone",
      ],
      [
        "others and off",
        { others: [m("Cy")], waiting: [off("Ben")] },
        "On Cy's and your phone. Waiting for Ben's phone",
      ],
      [
        "two off",
        { waiting: [off("Ben"), off("Dan")] },
        "On your phone. Waiting for Ben's and Dan's phones",
      ],
      [
        "one on, one off",
        { waiting: [w("Dan"), off("Ben")] },
        "On your phone. On its way to Dan's phone. Waiting for Ben's phone",
      ],
      [
        "quiet and off",
        {
          quiet: [{ key: "Cy", name: "Cy", connected: false, lastSeenAt: NOW }],
          waiting: [off("Ben")],
        },
        "On your phone. Waiting for Ben's phone. Cy's phone last had it just now",
      ],
    ];
    it.each(rows)("%s", (_name, holders, text) => {
      expect(holdersLine(h(holders)).text).toBe(text);
    });

    it("says nothing about waiting phones while the photo is still arriving here", () => {
      const waiting = [off("Ben"), w("Dan")];
      expect(holdersLine(h({ here: false, others: [m("Cy")], waiting })).text).toBe(
        "On Cy's phone. Arriving on yours…",
      );
    });

    it("ages with now: the same friend reads as on its way, then waiting", () => {
      const ben = { key: "Ben", name: "Ben", connected: false, lastSeenAt: 1000 };
      expect(holdersLine(h({ waiting: [ben] }), 1000 + 29_000).text).toBe(
        "On your phone. On its way to Ben's phone",
      );
      expect(holdersLine(h({ waiting: [ben] }), 1000 + 30_000).text).toBe(
        "On your phone. Waiting for Ben's phone",
      );
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
    const line = (...names: string[]) => holdersLine(h({ waiting: names.map((n) => w(n)) })).text;
    expect(line("Ben")).toBe("On your phone. On its way to Ben's phone");
    expect(line("Ben", "Cy")).toBe("On your phone. On its way to Ben's and Cy's phones");
    expect(line("a", "b", "c", "d")).toBe("On your phone. On its way to 4 phones");
    expect(line("Ben", "ben")).toBe("On your phone. On its way to 2 phones");
  });
  it("others haven't said stays, and the clause follows it", () => {
    expect(holdersLine(h({ unsure: [m("Jo")], waiting: [w("Nils")] })).text).toBe(
      "On your phone. Others haven't said. On its way to Nils's phone",
    );
  });
  it("a named holder line is followed by the waiting clause", () => {
    expect(holdersLine(h({ others: [m("Nils")], waiting: [w("Maya")] })).text).toBe(
      "On Nils's and your phone. On its way to Maya's phone",
    );
  });
  it("sheet rows carry waiting", () => {
    expect(holdersSheetRows(h({ waiting: [w("Maya")] })).waiting).toEqual([w("Maya")]);
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
    expect(holdersLine(h({ former: ["Ben"], unsure: [m("Jo")], waiting: [w("Nils")] })).text).toBe(
      "On your phone. Ben was removed and keeps a copy. On its way to Nils's phone",
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
    const ben = (key: string, name = "Ben") => ({ key, name, connected: true });
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
  const q = (name: string, lastSeenAt: number) => ({
    key: name,
    name,
    connected: false,
    lastSeenAt,
  });
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
    expect(deleteDetail(h({ others: [m("Ben")], waiting: [w("Cy")] }))).toBe(
      `${gone} Ben's phone stops showing it and drops its copy once it's connected. Cy doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("names only who lacks it", () => {
    expect(deleteDetail(h({ waiting: [w("Ben")] }))).toBe(
      `${gone} Ben doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
    );
  });
});

describe("deletedMessage", () => {
  const now = 1_000_000;
  const off = (name: string) => ({ key: name, name, connected: false, lastSeenAt: now - 60_000 });
  const rows: [string, Partial<PhotoHolders>, string][] = [
    ["alone", {}, "Deleted “Sunset”."],
    [
      "one keeps, one never got it",
      { others: [m("Ben")], waiting: [w("Cy")] },
      "Deleted “Sunset”. Ben has the full photo. Cy doesn't have the full photo.",
    ],
    [
      "two keep",
      { others: [m("Ana"), m("Ben")] },
      "Deleted “Sunset”. Ana and Ben have the full photo.",
    ],
    [
      "waiting away",
      { waiting: [w("Cy"), w("Dan")] },
      "Deleted “Sunset”. Cy and Dan don't have the full photo.",
    ],
    [
      "holder away",
      { others: [m("Ben"), off("Dan")] },
      "Deleted “Sunset”. Ben and Dan have the full photo. Dan will see it's gone when connected.",
    ],
    [
      "only unsure, former, left",
      { unsure: [m("Ben")], former: ["Eve"], left: ["Fay"] },
      "Deleted “Sunset”.",
    ],
  ];
  it.each(rows)("%s", (_, p, text) => {
    expect(deletedMessage("Sunset", h(p), {}, now)).toBe(text);
  });
  it("without holders", () => {
    expect(deletedMessage("Sunset", undefined, {}, now)).toBe("Deleted “Sunset”.");
  });
  it("names a person with only a preview by the friend name", () => {
    expect(
      deletedMessage(
        "Sunset",
        h({ previews: [{ key: "k1", name: "Ben", identity: "id-b", connected: true }] }),
        { "id-b": "Benny" },
        now,
      ),
    ).toBe("Deleted “Sunset”. The photo no longer shows for Benny.");
  });
  it("uses the friend name, else the phone's own name", () => {
    const others = [
      { key: "k1", name: "Ben", identity: "id-b", connected: true },
      { key: "k2", name: "Zed", connected: true },
    ];
    expect(deletedMessage("Sunset", h({ others }), { "id-b": "Benny" }, now)).toBe(
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
    expect(deleteDetail(h({ others: [m("Ben")], previews: [m("Cy")], waiting: [w("Dan")] }))).toBe(
      `${gone} Ben's and Cy's phones stop showing it and drop their copies once they're connected. Dan doesn't have the full photo. Copies saved outside Justus can't be taken back.`,
    );
  });
  it("the toast says who only has a preview, and who finds out when connected", () => {
    const cara = { key: "Cara", name: "Cara", connected: false, lastSeenAt: 1 };
    expect(deletedMessage("pixel-2.png", h({ previews: [m("Ben")] }), {}, 1_000_000)).toBe(
      "Deleted “pixel-2.png”. The photo no longer shows for Ben.",
    );
    expect(deletedMessage("b", h({ previews: [cara] }), {}, 1_000_000)).toBe(
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
          { key: "k1", name: "Ben", connected: true },
          { key: "k2", name: "Ben", connected: true },
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
    expect(deletedMessage("a.jpg", removed, {}, 0)).toBe(deletedMessage("a.jpg", undefined, {}, 0));
  });
});

describe("a quiet phone in the delete dialog and toast", () => {
  const q = (name: string) => ({ key: name, name, connected: false, lastSeenAt: 1 });
  it("still names the phone as having the full photo, after the fresh ones", () => {
    const holders = h({ others: [m("Cy")], quiet: [q("Ben")] });
    expect(deleteDetail(holders)).toBe(deleteDetail(h({ others: [m("Cy"), m("Ben")] })));
    expect(deleteDetail(holders)).toContain("Cy's and Ben's phones stop showing it");
  });
  it("tells a quiet phone that is not connected it will see the photo gone", () => {
    const now = 10 * 86_400_000;
    expect(deletedMessage("a", h({ quiet: [q("Ben")] }), {}, now)).toBe(
      deletedMessage("a", h({ others: [q("Ben")] }), {}, now),
    );
    expect(deletedMessage("a", h({ quiet: [q("Ben")] }), {}, now)).toContain(
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
  const q = (name: string) => ({ ...m(name), connected: false, lastSeenAt: 1 });
  const people = ["Ada", "Ben", "Cy", "Dan", "Eve", "Fay"].map((key, i) => ({ key, you: i === 0 }));

  it("counts each member from the sheet's lists", () => {
    const rest = { quiet: [q("Cy")], unsure: [m("Dan")], waiting: [w("Eve")] };
    const photos = [
      photoWith(h({ others: [m("Ben")], ...rest })),
      photoWith(h({ previews: [m("Ben")], ...rest })),
      photoWith(h({ here: false, previewHere: true, previews: [m("Ben")], ...rest })),
    ];
    const got = memberHoldings(photos, people);
    expect(got.get("Ada")).toEqual({ full: 2, previews: 1, waiting: 0, total: 3 });
    expect(got.get("Ben")).toEqual({ full: 1, previews: 2, waiting: 0, total: 3 });
    expect(got.get("Eve")).toEqual({ full: 0, previews: 0, waiting: 3, total: 3 });
    expect([...got.keys()]).toEqual(["Ada", "Ben", "Eve"]);
  });

  it("counts your own phone even when it holds neither copy", () => {
    const photos = [photoWith(h({ here: false })), photoWith(h({}))];
    expect(memberHoldings(photos, people).get("Ada")).toEqual({
      full: 1,
      previews: 0,
      waiting: 0,
      total: 2,
    });
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
    const line = (full: number, previews: number, waiting: number) =>
      memberPhotosLine({ full, previews, waiting, total: full + previews + waiting });
    expect(memberPhotosLine(undefined)).toBe("");
    expect(line(3, 0, 0)).toBe("3 in full");
    expect(line(1, 2, 0)).toBe("1 in full, 2 previews");
    expect(line(1, 1, 2)).toBe("1 in full, 1 preview, 2 waiting");
    expect(line(3, 0, 1)).toBe("3 in full, 1 waiting");
    expect(line(0, 2, 1)).toBe("2 previews, 1 waiting");
    expect(line(0, 1, 0)).toBe("1 preview");
  });
});

describe("leaverHolders", () => {
  const ph = (p?: Partial<PhotoHolders> | "removed") =>
    ({
      id: "x",
      holders:
        p === undefined ? undefined : p === "removed" ? { kind: "removed", here: true } : h(p),
    }) as never;

  it("knows an empty list, with nothing only on this phone", () => {
    expect(leaverHolders([])).toEqual({ kind: "known", keys: new Set(), sole: 0 });
  });
  it("is unknown when any photo's list is unset or from a removed phone", () => {
    expect(leaverHolders([ph({}), ph()])).toEqual({ kind: "unknown" });
    expect(leaverHolders([ph("removed")])).toEqual({ kind: "unknown" });
  });
  it("collects keys from full copies, quiet holders and previews across photos", () => {
    const quiet = { ...m("Q"), lastSeenAt: 1 };
    const got = leaverHolders([
      ph({ others: [m("A")] }),
      ph({ quiet: [quiet], previews: [m("P")] }),
    ]);
    expect(got).toEqual({ kind: "known", keys: new Set(["A", "Q", "P"]), sole: 0 });
  });
  it("counts a photo only waiting on others as sole", () => {
    expect(leaverHolders([ph({ waiting: [m("A")] })])).toMatchObject({ sole: 1 });
  });
  it("does not count a photo someone is unsure about, or a removed person kept, as sole", () => {
    expect(leaverHolders([ph({ unsure: [m("A")] })])).toMatchObject({ sole: 0 });
    expect(leaverHolders([ph({ former: ["Z"] })])).toMatchObject({ sole: 0 });
  });
  it("does not count a photo only previewed, or only held by a quiet phone, as sole", () => {
    expect(leaverHolders([ph({ previews: [m("P")] })])).toMatchObject({ sole: 0 });
    expect(leaverHolders([ph({ quiet: [{ ...m("Q"), lastSeenAt: 1 }] })])).toMatchObject({
      sole: 0,
    });
  });
});

describe("memberKeeps", () => {
  const ph = (id: string, by: string, mine: boolean, holders?: PhotoHolders) =>
    ({ id, mine, member: m(by), holders }) as unknown as Photo;
  it("counts full copies by whose photo, never previews or the person's own", () => {
    const ben = m("Ben");
    const photos = [
      ph("a", "Ada", true, h({ others: [ben] })),
      ph("b", "Cy", false, h({ quiet: [{ ...ben, lastSeen: 0 } as never] })),
      ph("c", "Cy", false, h({ previews: [ben] })),
      ph("d", "Cy", false, h({ waiting: [ben] })),
      ph("e", "Ben", false, h({})),
    ];
    expect(memberKeeps(photos, "Ben")).toEqual({ kind: "known", yours: 1, others: 1 });
    expect(memberKeeps([], "Ben")).toEqual({ kind: "known", yours: 0, others: 0 });
  });
  it("is unknown when Ben has not said for a photo or a list is missing", () => {
    expect(memberKeeps([ph("a", "Ada", true, h({ unsure: [m("Ben")] }))], "Ben").kind).toBe(
      "unknown",
    );
    expect(memberKeeps([ph("a", "Ada", true, h({}))], "Ben").kind).toBe("unknown");
    expect(memberKeeps([ph("a", "Ben", false)], "Ben").kind).toBe("unknown");
    expect(memberKeeps([ph("a", "Ada", true, { kind: "removed", here: true })], "Ben").kind).toBe(
      "unknown",
    );
  });
});
