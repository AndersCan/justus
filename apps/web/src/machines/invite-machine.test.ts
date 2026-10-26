import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { $invite, $inviteError, $inviteState, invites } from "./invite-machine";
import { sync } from "./sync-machine";

vi.mock("./sync-machine", () => ({ sync: { join: vi.fn() } }));

const KEY = "cd".repeat(32);
const joinMock = sync.join as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  joinMock.mockReset();
  invites.cancel();
  $inviteError.set(null);
});

describe("invite machine", () => {
  test("a valid link goes to review and does not join until confirmed", () => {
    invites.receive(`justus://join/${KEY}?n=Trip&a=Maya&m=2`);
    expect($inviteState.get()).toBe("reviewing");
    expect($invite.get()).toMatchObject({ key: KEY, name: "Trip", admin: "Maya", members: 2 });
    expect(joinMock).not.toHaveBeenCalled();
    invites.confirm();
    expect(joinMock).toHaveBeenCalledWith(KEY);
    expect($inviteState.get()).toBe("idle");
    expect($invite.get()).toBeNull();
  });

  test("cancel drops the invite without joining", () => {
    invites.receive(KEY);
    invites.cancel();
    expect($inviteState.get()).toBe("idle");
    expect(joinMock).not.toHaveBeenCalled();
  });

  test("garbage sets an error and stays idle", () => {
    invites.receive("nope");
    expect($inviteState.get()).toBe("idle");
    expect($inviteError.get()).toMatch(/doesn't look right/);
  });
});
