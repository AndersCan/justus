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
  pageChanged: [] as ((page: unknown, old: unknown) => void)[],
}));

vi.mock("../../gateway", () => ({
  gateway: {
    ask: mocks.ask,
    dismissDeclinedAsk: mocks.dismissDeclinedAsk,
    cancelAsk: mocks.cancelAsk,
  },
}));
vi.mock("../router-machine", () => ({
  open: mocks.open,
  currentPage: mocks.currentPage,
  onPageChange: (fn: (page: unknown, old: unknown) => void) => {
    mocks.pageChanged.push(fn);
    return () => {};
  },
}));
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

const { join, joinActor, joinViewOf, joinedNow } = await import("./join-request");
const { joinRequestMachine } = await import("./join-request-machine");
const { foldersActor } = (await import("../folders-machine")) as unknown as {
  foldersActor: { snapshot: () => { context: { folders: unknown[]; asks: unknown[] } } };
};
const foldersContext = foldersActor.snapshot().context;
const view = () => joinViewOf(joinActor.snapshot());

const INVITE: JoinInvite = { code: "a".repeat(64), owner: "b".repeat(64) };
const LINK = buildInviteLink({ ...INVITE, album: "Holiday", ownerName: "Mallory" });
const settle = () => joinActor.settled();

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.currentPage.mockReturnValue(undefined);
  foldersContext.folders = [];
  foldersContext.asks = [];
  join.closeWaiting();
  join.dismissDecline();
  join.closeStoppedLink();
  await settle();
});

describe("the line saying you were let in", () => {
  const accept = async () => {
    join.requestAnswered({ code: INVITE.code, answer: "accepted", folderId: "f1" });
    await settle();
  };
  const move = (old: { route: string; params: { id: string } }) => {
    for (const fn of mocks.pageChanged) fn(undefined, old);
  };

  test("goes when the person leaves the album the accept opened", async () => {
    await accept();
    expect(joinedNow(joinActor.snapshot())).toEqual({ folderId: "f1" });
    move({ route: "photoAlbum", params: { id: "f1" } });
    await settle();
    expect(joinedNow(joinActor.snapshot())).toBeUndefined();
  });

  test("stays when the person leaves another page", async () => {
    await accept();
    move({ route: "photoAlbum", params: { id: "f2" } });
    move({ route: "sharing", params: { id: "f1" } });
    await settle();
    expect(joinedNow(joinActor.snapshot())).toEqual({ folderId: "f1" });
    move({ route: "photoAlbum", params: { id: "f1" } });
    await settle();
  });
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
    expect(mocks.ask).toHaveBeenCalledWith(INVITE.code, INVITE.owner, undefined);
    expect(view().state).toBe("waitingForAdminToAccept");
  });

  test("asking through a link with an end time passes the end time", async () => {
    const endsAt = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(buildInviteLink({ ...INVITE, album: "", ownerName: "", expiresAt: endsAt }));
    await settle();
    join.askToJoin();
    await settle();
    expect(mocks.ask).toHaveBeenCalledWith(INVITE.code, INVITE.owner, endsAt);
  });

  test("an ask turned away by its ended link does not stop another link of the album", async () => {
    const ended = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    const live = ended + 86_400_000;
    foldersContext.asks = [{ code: INVITE.code, status: "linkOff", why: "ended", linkEnd: ended }];
    const link = (expiresAt: number) =>
      buildInviteLink({ ...INVITE, album: "", ownerName: "", expiresAt });
    join.openLink(link(ended));
    await settle();
    expect(view().state, "the same link").toBe("linkStoppedForUnknownReason");
    mocks.cancelAsk.mockResolvedValue([null, {}]);
    join.closeStoppedLink();
    await settle();
    foldersContext.asks = [{ code: INVITE.code, status: "linkOff", why: "ended", linkEnd: ended }];
    join.openLink(link(live));
    await settle();
    expect(view().state, "another link").toBe("decidingToAsk");
    join.notNow();
    await settle();
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

  test("Close on a dead request asks the backend to take it off the list", async () => {
    mocks.cancelAsk.mockResolvedValue([null, { ok: true }]);
    foldersContext.asks = [{ code: INVITE.code, status: "linkOff" }];
    join.reopenRequest({
      code: INVITE.code,
      owner: INVITE.owner,
      albumName: "Spain 2026",
      ownerName: "Nils",
      askedAt: 1,
      status: "linkOff",
      why: "turnedOff",
    });
    await settle();
    expect(view().state).toBe("linkTurnedOffByAdmin");
    join.closeStoppedLink();
    await settle();
    expect(mocks.cancelAsk).toHaveBeenCalledWith(INVITE.code);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(view().state).toBe("noInviteOpen");
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
    join.requestAnswered({ code: INVITE.code, answer: "accepted", folderId: "f7" });
    await settle();
    expect(mocks.open).toHaveBeenCalledWith("/albums/f7", { replace: false });
  });

  test("a declined answer shows the not-accepted screen", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    join.requestAnswered({ code: INVITE.code, answer: "declined" });
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
    const fresh = joinRequestMachine.create({
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
    expect(view.invite).toEqual({ ...INVITE, album: "", ownerName: "", linkAlbum: "Holiday" });
  });
});

describe("wireAsksToJoin", () => {
  const foldersChanged = async () => {
    for (const fn of mocks.listeners) fn();
    await settle();
  };
  const mark = (whoMustUpdate?: "you") => {
    foldersContext.asks = [{ code: INVITE.code, albumName: "", ownerName: "", whoMustUpdate }];
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

  const heard = (albumName: string, ownerName: string) => {
    foldersContext.asks = [{ code: INVITE.code, albumName, ownerName }];
  };

  test("names the Admin's phone sent reach the open waiting screen", async () => {
    await wait();
    expect(view().invite).toMatchObject({ album: "", ownerName: "" });
    heard("Spain 2026", "Ada");
    await foldersChanged();
    expect(view().state).toBe("waitingForAdminToAccept");
    expect(view().invite).toMatchObject({ album: "Spain 2026", ownerName: "Ada" });
  });

  test("the same names again send nothing", async () => {
    await wait();
    heard("Spain 2026", "Ada");
    await foldersChanged();
    const sent = vi.spyOn(joinActor, "send");
    await foldersChanged();
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  test("an ask with no album name yet sends no names", async () => {
    await wait();
    const sent = vi.spyOn(joinActor, "send");
    heard("", "Ada");
    await foldersChanged();
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  test("a name change on the open ask updates the screen", async () => {
    await wait();
    heard("Spain 2026", "Ada");
    await foldersChanged();
    heard("Spain 2027", "Ada");
    await foldersChanged();
    expect(view().invite).toMatchObject({ album: "Spain 2027" });
  });

  test("a change of the Admin's name alone updates the screen", async () => {
    await wait();
    heard("Spain 2026", "Ada");
    await foldersChanged();
    heard("Spain 2026", "Bea");
    await foldersChanged();
    expect(view().invite).toMatchObject({ album: "Spain 2026", ownerName: "Bea" });
  });

  test("a mark on another request leaves the screen alone", async () => {
    await wait();
    foldersContext.asks = [
      { code: "c".repeat(64), albumName: "", ownerName: "", whoMustUpdate: "you" },
    ];
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
      albumName: "Spain 2026",
      ownerName: "Ada",
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
