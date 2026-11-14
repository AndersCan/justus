import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { albumHolding, holdingLine } from "./holding";
import { deleteDetail } from "./holders";

const m = (key: string) => ({ key, name: key });
const photo = (folderId: string, holders: Partial<PhotoHolders>): Photo =>
  ({
    id: "p",
    folderId,
    holders: {
      here: false,
      others: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
      ...holders,
    },
  }) as Photo;

describe("privacy copy states only what is true", () => {
  // PhotoHolders.waiting: "phone said what it holds, without this photo or its preview".
  it("a member with no photo and no preview is not told 'seen, not opened'", () => {
    const r = albumHolding([photo("f1", { waiting: [m("w")] })], "f1");
    expect(holdingLine(r.byKey.get("w"), r.total)).not.toContain("previews");
  });
  it("a member holding one photo, with no preview of the other, is not told 'previews of the rest'", () => {
    const r = albumHolding(
      [photo("f1", { others: [m("k")] }), photo("f1", { waiting: [m("k")] })],
      "f1",
    );
    expect(holdingLine(r.byKey.get("k"), r.total)).not.toContain("previews");
  });
  it("one phone holding the full photo is not told 'Copies ... their phones'", () => {
    const h = {
      here: true,
      others: [m("Nils")],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    };
    expect(deleteDetail(h)).not.toContain("their phones");
  });
});
