import { VirtualClock } from "@mantaq/core";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  dismissDeclinedAsk: vi.fn(),
  cancelAsk: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  currentPage: vi.fn(() => undefined as { route: string } | undefined),
  listeners: [] as (() => void)[],
}));

vi.mock("../../gateway", () => ({
  gateway: {
    ask: mocks.ask,
    dismissDeclinedAsk: mocks.dismissDeclinedAsk,
    cancelAsk: mocks.cancelAsk,
  },
}));
vi.mock("../router-machine", () => ({ open: mocks.open, currentPage: mocks.currentPage }));
vi.mock("../folders-machine", () => {
  const context = { folders: [] as unknown[], asks: [] as unknown[] };
  return {
    foldersActor: {
      snapshot: () => ({ context }),
      on: (_event: string, o: { fn: () => void }) => {
        mocks.listeners.push(o.fn);
        return () => {};
      },
    },
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
  mocks.currentPage.mockReturnValue(undefined);
  foldersContext.folders = [];
  foldersContext.asks = [];
  join.closeWaiting();
  join.dismissDecline();
  join.closeLinkTurnedOff();
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

  test("an album opened from the welcome screen replaces it; elsewhere it is pushed", async () => {
    foldersContext.folders = [
      { id: "f9", role: "member", invite: { code: INVITE.code, owner: INVITE.owner } },
    ];
    mocks.currentPage.mockReturnValue({ route: "welcome" });
    join.openLink(LINK);
    await settle();
    expect(mocks.open).toHaveBeenLastCalledWith("/albums/f9", { replace: true });
    mocks.currentPage.mockReturnValue({ route: "albums" });
    join.openLink(LINK);
    await settle();
    expect(mocks.open).toHaveBeenLastCalledWith("/albums/f9", { replace: false });
  });

  test("a link whose ask was declined asks again", async () => {
    foldersContext.asks = [{ code: INVITE.code, status: "declined" }];
    join.openLink(LINK);
    await settle();
    expect(view().state).toBe("decidingToAsk");
  });

  test("Cancel request on a turned-off request asks the backend to take it back", async () => {
    mocks.cancelAsk.mockResolvedValue([null, { ok: true }]);
    join.reopenRequest({
      code: INVITE.code,
      owner: INVITE.owner,
      albumName: "Spain 2026",
      ownerName: "Nils",
      askedAt: 1,
      status: "linkOff",
    });
    await settle();
    expect(view().state).toBe("linkTurnedOff");
    join.cancelRequest();
    await settle();
    expect(mocks.cancelAsk).toHaveBeenCalledWith(INVITE.code);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(view().state).toBe("noInviteOpen");
  });

  test("Close on a turned-off request keeps the row and closes the sheet", async () => {
    join.reopenRequest({
      code: INVITE.code,
      owner: INVITE.owner,
      albumName: "Spain 2026",
      ownerName: "Nils",
      askedAt: 1,
      status: "linkOff",
    });
    await settle();
    join.closeLinkTurnedOff();
    await settle();
    expect(view().state).toBe("noInviteOpen");
    expect(mocks.cancelAsk).not.toHaveBeenCalled();
  });

  test("OK on a decline takes the request off and refreshes the list", async () => {
    mocks.dismissDeclinedAsk.mockResolvedValue([null, { ok: true }]);
    join.reopenRequest({
      code: INVITE.code,
      owner: INVITE.owner,
      albumName: "Spain 2026",
      ownerName: "Nils",
      askedAt: 1,
      status: "declined",
    });
    await settle();
    join.dismissDecline();
    await settle();
    expect(mocks.dismissDeclinedAsk).toHaveBeenCalledWith(INVITE.code);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(view().state).toBe("noInviteOpen");
  });

  test("Cancel request asks the backend to take the request back and refreshes the albums", async () => {
    mocks.ask.mockResolvedValue([null, { ok: true }]);
    mocks.cancelAsk.mockResolvedValue([null, { ok: true }]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect(view().state).toBe("waitingForAdminToAccept");
    mocks.refresh.mockClear();
    join.cancelRequest();
    await settle();
    expect(mocks.cancelAsk).toHaveBeenCalledWith(INVITE.code);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(view().state).toBe("noInviteOpen");
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

describe("wireAsksToJoin", () => {
  const foldersChanged = async () => {
    for (const fn of mocks.listeners) fn();
    await settle();
  };
  const mark = (whoMustUpdate?: "you") => {
    foldersContext.asks = [{ code: INVITE.code, whoMustUpdate }];
  };
  const wait = async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
  };

  test("a mark on the open ask moves the screen, and clearing it moves it back", async () => {
    await wait();
    mark("you");
    await foldersChanged();
    expect(view().state).toBe("waitingForYouToUpdate");
    mark(undefined);
    await foldersChanged();
    expect(view().state).toBe("waitingForAdminToAccept");
  });

  test("the same mark again sends nothing", async () => {
    await wait();
    mark("you");
    await foldersChanged();
    const sent = vi.spyOn(joinActor, "send");
    await foldersChanged();
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  test("a mark on another request leaves the screen alone", async () => {
    await wait();
    foldersContext.asks = [{ code: "c".repeat(64), whoMustUpdate: "you" }];
    await foldersChanged();
    expect(view().state).toBe("waitingForAdminToAccept");
  });

  test("a mark that comes after close and reopen still moves the screen", async () => {
    await wait();
    join.closeWaiting();
    await settle();
    join.reopenRequest({
      code: INVITE.code,
      owner: INVITE.owner,
      albumName: INVITE.album,
      ownerName: INVITE.ownerName,
      askedAt: 1,
      status: "waiting",
    });
    await settle();
    mark("you");
    await foldersChanged();
    expect(view().state).toBe("waitingForYouToUpdate");
  });

  test("with no waiting screen open nothing is sent", async () => {
    await wait();
    mark("you");
    await foldersChanged();
    join.closeWaiting();
    await settle();
    const sent = vi.spyOn(joinActor, "send");
    await foldersChanged();
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
    mark(undefined);
    join.openLink(LINK);
    await settle();
    expect(view().state).toBe("decidingToAsk");
  });
});
