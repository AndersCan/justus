import { describe, expect, test, vi } from "vite-plus/test";
import { gateway } from "../../gateway";
import { sync } from "../sync-machine";
import { inviteLink, inviteLinkActor, inviteLinkViewOf } from "./invite-link";

vi.mock("../../gateway", () => ({
  gateway: {
    turnOffInvite: vi.fn(async () => [null, {}]),
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
    endInviteLink: vi.fn(async () => [null, { ok: true }]),
  },
}));
vi.mock("../sync-machine", () => ({ sync: { refresh: vi.fn() } }));
vi.mock("../../views/toast", () => ({ toast: vi.fn() }));

describe("the album list follows the links", () => {
  test("saving a new link refreshes the album, and a failed save does not", async () => {
    inviteLink.makeNewLink("f1", "c1");
    await inviteLinkActor.settled();
    expect(sync.refresh).toHaveBeenCalledTimes(1);
    vi.mocked(gateway.saveInviteLink).mockResolvedValueOnce([new Error("no"), null] as never);
    inviteLink.makeNewLink("f1", "c1");
    await inviteLinkActor.settled();
    expect(sync.refresh).toHaveBeenCalledTimes(1);
  });

  test("ending a link refreshes the album, and a failed end does not", async () => {
    vi.mocked(sync.refresh).mockClear();
    inviteLink.endLink("f1", { endsAt: 5000 });
    await inviteLinkActor.settled();
    expect(gateway.endInviteLink).toHaveBeenCalledWith("f1", 5000);
    expect(sync.refresh).toHaveBeenCalledTimes(1);
    vi.mocked(gateway.endInviteLink).mockResolvedValueOnce([new Error("no"), null] as never);
    inviteLink.endLink("f1", { endsAt: 6000 });
    await inviteLinkActor.settled();
    expect(sync.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the view while a link is ending", () => {
  test("names the end of the link being ended", async () => {
    let finish = (_: unknown) => {};
    vi.mocked(gateway.endInviteLink).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as never,
    );
    inviteLink.endLink("f1", { endsAt: 7000 });
    expect(inviteLinkViewOf(inviteLinkActor.snapshot())).toMatchObject({
      state: "endingLink",
      endingEndsAt: 7000,
    });
    finish([null, { ok: true }]);
    await inviteLinkActor.settled();
    expect(inviteLinkViewOf(inviteLinkActor.snapshot()).endingEndsAt).toBeUndefined();
  });
});
