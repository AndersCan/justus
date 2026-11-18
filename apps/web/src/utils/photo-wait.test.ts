import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { photoWait } from "./photo-wait";

const m = (name: string) => ({ key: name, name });
const members = (...on: string[]) =>
  ["Ada", "Ben", "Cara"].map((key) => ({ key, connected: on.includes(key) }));
const base = (holders: PhotoHolders | undefined, thumb = true): Photo => ({
  id: "a",
  url: "u",
  ...(thumb ? { thumbUrl: "t" } : {}),
  name: "a",
  mime: "image/jpeg",
  size: 1,
  addedAt: 0,
  member: m("Ada"),
  ...(holders ? { holders } : {}),
});
const h = (p: Partial<Extract<PhotoHolders, { kind: "inAlbum" }>>): PhotoHolders => ({
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

describe("photoWait", () => {
  it("counts photos a member's phone lacks, once per photo", () => {
    const photos = [base(h({ waiting: [m("Ben"), m("Cara")] })), base(h({ waiting: [m("Ben")] }))];
    expect(photoWait(photos, members("Ada"))).toEqual({
      waitsFor: { count: 2, phones: [m("Ben"), m("Cara")] },
    });
  });
  it("counts a missing preview only while a phone that has it is connected", () => {
    const lacking = base(h({ here: false, others: [m("Ada")] }));
    expect(photoWait([lacking], members("Ada"))).toEqual({ coming: 1 });
    expect(photoWait([lacking], members("Cara"))).toEqual({});
    const previewHeld = base(h({ here: false, others: [], previews: [m("Cara")] }));
    expect(photoWait([previewHeld], members("Cara"))).toEqual({ coming: 1 });
  });
  it("says both parts", () => {
    const photos = [base(h({ here: false, others: [m("Ada")] })), base(h({ waiting: [m("Ben")] }))];
    expect(photoWait(photos, members("Ada"))).toEqual({
      coming: 1,
      waitsFor: { count: 1, phones: [m("Ben")] },
    });
  });
  it("ignores phones that have not said, show previews, were removed or left", () => {
    const photo = base(
      h({ unsure: [m("Ben")], previews: [m("Cara")], former: ["X"], left: ["Y"] }),
    );
    expect(photoWait([photo], members("Ada", "Ben", "Cara"))).toEqual({});
  });
  it("ignores photos without a preview, without holders or from a removed phone", () => {
    const photos = [
      base(h({ waiting: [m("Ben")] }), false),
      base(undefined),
      base({ kind: "removed", here: true } as unknown as PhotoHolders),
    ];
    expect(photoWait(photos, members("Ada"))).toEqual({});
  });
  it("a photo this phone lacks never says it waits for another phone", () => {
    const lacking = base(h({ here: false, others: [m("Ada")], waiting: [m("Cara")] }));
    expect(photoWait([lacking], members("Ada"))).toEqual({ coming: 1 });
  });
  it("a preview this phone has adds nothing to coming", () => {
    expect(photoWait([base(h({ here: false, previewHere: true }))], members("Ada"))).toEqual({});
  });
});
