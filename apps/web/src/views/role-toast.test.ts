import { describe, expect, test, vi } from "vite-plus/test";
import { roleToast, roleToastText, type RoleChangeIn } from "./role-toast";
import { toast } from "./toast";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const change = (over: Partial<RoleChangeIn>): RoleChangeIn => ({
  folderId: "f1",
  from: "member",
  to: "reader",
  albumName: "Summer",
  adminName: "Anna",
  ...over,
});

describe("roleToastText", () => {
  test("a demotion names the Admin", () => {
    expect(roleToastText(change({})).text).toBe("Anna stopped you adding photos to Summer");
  });

  test("a promotion names the Admin", () => {
    expect(roleToastText(change({ from: "reader", to: "member" })).text).toBe(
      "Anna let you add photos to Summer",
    );
  });

  test("without a name, a demotion says the Admin", () => {
    expect(roleToastText(change({ adminName: undefined })).text).toBe(
      "The Admin stopped you adding photos to Summer",
    );
  });

  test("without a name, a promotion says the Admin", () => {
    expect(roleToastText(change({ from: "reader", to: "member", adminName: undefined })).text).toBe(
      "The Admin let you add photos to Summer",
    );
  });
});

describe("roleToast.changed", () => {
  test("shows the message", () => {
    roleToast.changed(change({}));
    expect(toast).toHaveBeenLastCalledWith("Anna stopped you adding photos to Summer");
  });

  test("a change to the same role shows nothing", () => {
    vi.mocked(toast).mockClear();
    roleToast.changed(change({ from: "member", to: "member" }));
    expect(toast).not.toHaveBeenCalled();
  });
});
