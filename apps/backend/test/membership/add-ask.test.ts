import { describe, it, expect } from "vite-plus/test";
import { parseAddAsk } from "../../src/membership/add-ask.ts";

describe("parseAddAsk", () => {
  it("reads when the Viewer asked", () => {
    expect(parseAddAsk('{"askedAt":1700000000000}')).toEqual({ askedAt: 1700000000000 });
  });

  it("is no ask for a missing, malformed or unusable file", () => {
    for (const text of [null, "nope", "[]", "{}", '{"askedAt":"x"}', '{"askedAt":0}']) {
      expect(parseAddAsk(text)).toBeUndefined();
    }
  });
});
