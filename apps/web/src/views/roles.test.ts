import { describe, expect, it } from "vite-plus/test";
import { roleLabel } from "./albums";
import { adminName } from "./invite";

describe("roleLabel", () => {
  it("uses the plain role words", () => {
    expect(roleLabel("creator")).toBe("Admin");
    expect(roleLabel("member")).toBe("Member");
    expect(roleLabel("reader")).toBe("Viewer");
  });

  it("calls a pending join a request, not a Viewer", () => {
    expect(roleLabel("reader", true)).toBe("Waiting for approval");
  });
});

describe("adminName", () => {
  const member = (name: string, admin: boolean) => ({ name, admin });

  it("names the Admin once known", () => {
    expect(adminName({ members: [member("Ingrid", false), member("Maya", true)] })).toBe("Maya");
  });

  it("falls back to the role while the name is unknown", () => {
    expect(adminName(null)).toBe("the Admin");
    expect(adminName({ members: [member("Ingrid", false)] })).toBe("the Admin");
    expect(adminName({ members: [member("Unknown device", true)] })).toBe("the Admin");
  });
});
