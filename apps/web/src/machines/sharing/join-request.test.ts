import { VirtualClock } from "@mantaq/core";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../gateway", () => ({ gateway: { ask: mocks.ask } }));
vi.mock("../router-machine", () => ({ open: mocks.open, currentPage: () => undefined }));
vi.mock("../folders-machine", () => {
  const context = { folders: [] as unknown[], asks: [] as unknown[] };
  return {
    foldersActor: { snapshot: () => ({ context }) },
    folders: { refresh: mocks.refresh },
  };
});

const { join, joinActor, joinViewOf } = await import("./join-request");
const { createJoinRequestActor } = await import("./join-request-machine");
const { foldersActor } = (await import("../folders-machine")) as unknown as {
  foldersActor: { snapshot: () => { context: { folders: unknown[]; asks: unknown[] } } };
};
const foldersContext = foldersActor.snapshot().context;
const view = () => joinViewOf(joinActor.snapshot());

const INVITE: JoinInvite = {
  code: "a".repeat(64),
  owner: "b".repeat(64),
  album: "Spain 2026",
  ownerName: "Nils",
};
const LINK = buildInviteLink(INVITE);
const settle = () => joinActor.settled();

beforeEach(async () => {
  vi.clearAllMocks();
  foldersContext.folders = [];
  foldersContext.asks = [];
  join.closeWaiting();
  join.dismissDecline();
  await settle();
});

describe("join singleton", () => {
  test("a link shows the ask screen for that album", async () => {
    join.openLink(LINK);
    await settle();
    expect(view()).toMatchObject({ state: "decidingToAsk", invite: INVITE, error: "" });
  });

  test("asking sends the request and moves to waiting", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect(mocks.ask).toHaveBeenCalledWith(INVITE.code, INVITE.owner, "Spain 2026", "Nils");
    expect(view().state).toBe("waitingForAdminToAccept");
  });

  test("a failed request keeps the screen and shows the error, then refreshes nothing", async () => {
    mocks.ask.mockResolvedValue([new Error("offline"), null]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect(view().state).toBe("decidingToAsk");
    expect(view().error).not.toBe("");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  test("a sent request refreshes the albums list", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  test("closing returns the view to idle with no invite", async () => {
    join.openLink(LINK);
    await settle();
    join.notNow();
    await settle();
    expect(view()).toEqual({ state: "noInviteOpen", invite: null, error: "" });
  });

  test("a link for an album I already joined opens it", async () => {
    foldersContext.folders = [
      { id: "f9", role: "member", invite: { code: INVITE.code, owner: INVITE.owner } },
    ];
    join.openLink(LINK);
    await settle();
    expect(mocks.open).toHaveBeenCalledWith("/albums/f9", { replace: false });
  });

  test("a link whose ask is declined shows the not-accepted screen", async () => {
    foldersContext.asks = [{ code: INVITE.code, status: "declined" }];
    join.openLink(LINK);
    await settle();
    expect(view().state).toBe("declinedByAdmin");
  });

  test("a link whose ask is waiting shows the waiting screen", async () => {
    foldersContext.asks = [{ code: INVITE.code, status: "waiting" }];
    join.openLink(LINK);
    await settle();
    expect(view().state).toBe("waitingForAdminToAccept");
  });

  test("an accepted answer opens the album", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    join.requestAnswered(INVITE.code, "accepted", "f7");
    await settle();
    expect(mocks.open).toHaveBeenCalledWith("/albums/f7", { replace: false });
  });

  test("a declined answer shows the not-accepted screen", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    join.requestAnswered(INVITE.code, "declined");
    await settle();
    expect(view().state).toBe("declinedByAdmin");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  test("a garbled link shows an error and no invite", async () => {
    join.openLink("not a link");
    await settle();
    expect(view().invite).toBeNull();
  });
});

describe("joinViewOf", () => {
  test("initial snapshot has no invite", () => {
    const fresh = createJoinRequestActor({
      clock: VirtualClock(),
      known: () => ({ kind: "new" }) as never,
      port: { ask: async () => [null, null] as never },
    });
    expect(joinViewOf(fresh.snapshot())).toEqual({
      state: "noInviteOpen",
      invite: null,
      error: "",
    });
  });

  test("an opened link shows the invite", async () => {
    join.openLink(LINK);
    await settle();
    const view = joinViewOf(joinActor.snapshot());
    expect(view.state).toBe("decidingToAsk");
    expect(view.invite).toMatchObject({ album: "Spain 2026" });
  });
});
