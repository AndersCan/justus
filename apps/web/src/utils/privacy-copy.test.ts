import { describe, expect, it } from "vite-plus/test";
import { deleteDetail } from "./holders";

describe("privacy copy states only what is true", () => {
  it("one phone holding the full photo is not told 'Copies ... their phones'", () => {
    const h = {
      kind: "inAlbum" as const,
      here: true,
      previewHere: false,
      others: [{ key: "Nils", name: "Nils", connected: true }],
      quiet: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    };
    expect(deleteDetail(h)).not.toContain("their phones");
  });
});
