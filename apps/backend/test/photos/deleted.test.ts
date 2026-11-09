import { describe, expect, it } from "vite-plus/test";
import { deletedSince, vanishedDrives, type Listing } from "../../src/photos/deleted.ts";

const drive = { name: "drive" };
const other = { name: "other" };

function listing(over: Partial<Listing> & { keys?: string[] } = {}): Listing {
  const { keys = ["A:p1"], ...rest } = over;
  return {
    seq: 1,
    role: "member",
    notice: undefined,
    complete: true,
    sources: new Map([
      ["A", drive],
      ["ME", drive],
    ]),
    photos: new Map(
      keys.map((k) => [
        k,
        {
          driveKey: k.split(":")[0],
          name: `${k}.jpg`,
          adderName: k.startsWith("ME") ? "Me" : "Ann",
        },
      ]),
    ),
    ...rest,
  };
}

const empty = listing({ keys: [] });
const ctx = {
  removed: {} as Record<string, unknown>,
  selfKey: "ME",
  adminName: "Ann" as string | undefined,
  deletedHere: new Set<string>(),
  left: new Set<string>(),
};

describe("deletedSince", () => {
  it("names the adder for a photo gone from their drive", () => {
    expect(deletedSince(listing(), empty, ctx)).toEqual([
      { name: "A:p1.jpg", adderName: "Ann", mine: false, deletedBy: "Ann" },
    ]);
  });

  it("names the Admin for a photo in the removed list, and sets mine", () => {
    expect(
      deletedSince(listing({ keys: ["ME:p2"] }), empty, {
        ...ctx,
        removed: { "ME:p2": {} },
        adminName: "Boss",
      }),
    ).toEqual([{ name: "ME:p2.jpg", adderName: "Me", mine: true, deletedBy: "Boss" }]);
  });

  it("leaves deletedBy unset when the Admin's name is unknown", () => {
    expect(
      deletedSince(listing(), empty, { ...ctx, removed: { "A:p1": {} }, adminName: undefined }),
    ).toEqual([{ name: "A:p1.jpg", adderName: "Ann", mine: false }]);
  });

  it("leaves deletedBy unset for an Unknown device adder", () => {
    const prev = listing();
    prev.photos.get("A:p1")!.adderName = "Unknown device";
    expect(deletedSince(prev, empty, ctx)).toEqual([
      { name: "A:p1.jpg", adderName: "Unknown device", mine: false },
    ]);
  });

  it("says nothing for a still-listed photo", () => {
    expect(deletedSince(listing(), listing(), ctx)).toEqual([]);
  });

  it("leaves deletedBy unset for a New member adder", () => {
    const prev = listing();
    prev.photos.get("A:p1")!.adderName = "New member";
    expect(deletedSince(prev, empty, ctx)).toEqual([
      { name: "A:p1.jpg", adderName: "New member", mine: false },
    ]);
  });

  it("says nothing for the first listing", () => {
    expect(deletedSince(undefined, empty, ctx)).toEqual([]);
  });

  it("says nothing when the role changed", () => {
    expect(deletedSince(listing(), { ...empty, role: "reader" }, ctx)).toEqual([]);
  });

  it("says nothing when either listing has a notice", () => {
    expect(
      deletedSince(listing({ notice: "moved" }), empty, ctx).concat(
        deletedSince(listing(), { ...empty, notice: "removed" }, ctx),
      ),
    ).toEqual([]);
  });

  it("says nothing when either listing is incomplete", () => {
    expect(
      deletedSince(listing({ complete: false }), empty, ctx).concat(
        deletedSince(listing(), { ...empty, complete: false }, ctx),
      ),
    ).toEqual([]);
  });

  it("says nothing for a delete this phone made", () => {
    expect(deletedSince(listing(), empty, { ...ctx, deletedHere: new Set(["A:p1"]) })).toEqual([]);
  });

  it("says nothing for a photo whose adder left", () => {
    expect(deletedSince(listing(), empty, { ...ctx, left: new Set(["A"]) })).toEqual([]);
  });

  it("lists the drives of vanished photos only", () => {
    expect([
      ...vanishedDrives(listing({ keys: ["A:p1", "ME:p2"] }), listing({ keys: ["A:p1"] })),
    ]).toEqual(["ME"]);
    expect([...vanishedDrives(undefined, empty)]).toEqual([]);
  });

  it("says nothing when the photo's drive was not listed before", () => {
    expect(deletedSince(listing({ sources: new Map() }), empty, ctx)).toEqual([]);
  });

  it("says nothing when the drive is a different object now", () => {
    expect(deletedSince(listing(), { ...empty, sources: new Map([["A", other]]) }, ctx)).toEqual(
      [],
    );
  });

  it("says nothing for this phone's own photo with no tombstone", () => {
    expect(deletedSince(listing({ keys: ["ME:p2"] }), empty, ctx)).toEqual([]);
  });

  it("reports only the photos that left", () => {
    expect(
      deletedSince(listing({ keys: ["A:p1", "A:p2"] }), listing({ keys: ["A:p2"] }), ctx),
    ).toEqual([{ name: "A:p1.jpg", adderName: "Ann", mine: false, deletedBy: "Ann" }]);
  });
});
