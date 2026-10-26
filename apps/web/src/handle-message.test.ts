import { describe, it, expect } from "vite-plus/test";
import { changeCause } from "./handle-message";

describe("changeCause", () => {
  it("reads the cause from a dispatch header", () => {
    expect(changeCause({ args: { cause: "presence" } })).toBe("presence");
  });

  it("ignores headers without one", () => {
    expect(changeCause({})).toBeUndefined();
    expect(changeCause({ args: { cause: 3 } })).toBeUndefined();
  });
});
