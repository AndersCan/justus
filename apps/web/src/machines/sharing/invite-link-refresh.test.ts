import { describe, expect, test, vi } from "vite-plus/test";
import { gateway } from "../../gateway";
import { sync } from "../sync-machine";
import { inviteLink, inviteLinkActor } from "./invite-link";

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
