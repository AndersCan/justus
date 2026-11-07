import { atom } from "nanostores";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../gateway", () => ({ gateway: { ask: mocks.ask } }));
vi.mock("../router-machine", () => ({ open: mocks.open }));
vi.mock("../folders-machine", async () => {
  const { atom: a } = await import("nanostores");
  return { $folders: a([]), $asks: a([]), folders: { refresh: mocks.refresh } };
});

const { $join, join, joinActor } = await import("./join-request");
const { $asks, $folders } = (await import("../folders-machine")) as unknown as {
  $asks: ReturnType<typeof atom<unknown[]>>;
  $folders: ReturnType<typeof atom<unknown[]>>;
};

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
  $folders.set([]);
  $asks.set([]);
  join.closeWaiting();
  join.dismissDecline();
  await settle();
});

describe("join singleton", () => {
  test("a link shows the ask screen for that album", async () => {
    join.openLink(LINK);
    await settle();
    expect($join.get()).toMatchObject({ state: "decidingToAsk", invite: INVITE, error: "" });
  });

  test("asking sends the request and moves to waiting", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect(mocks.ask).toHaveBeenCalledWith(INVITE.code, INVITE.owner, "Spain 2026", "Nils");
    expect($join.get().state).toBe("waitingForAnswer");
  });

  test("a failed request keeps the screen and shows the error, then refreshes nothing", async () => {
    mocks.ask.mockResolvedValue([new Error("offline"), null]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    expect($join.get().state).toBe("decidingToAsk");
    expect($join.get().error).not.toBe("");
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
    expect($join.get()).toEqual({ state: "noInvite", invite: null, error: "" });
  });

  test("a link for an album I already joined opens it", async () => {
    $folders.set([
      { id: "f9", role: "member", invite: { code: INVITE.code, owner: INVITE.owner } },
    ]);
    join.openLink(LINK);
    await settle();
    expect(mocks.open).toHaveBeenCalledWith("/albums/f9");
  });

  test("a link whose ask is declined shows the not-accepted screen", async () => {
    $asks.set([{ code: INVITE.code, status: "declined" }]);
    join.openLink(LINK);
    await settle();
    expect($join.get().state).toBe("declined");
  });

  test("a link whose ask is waiting shows the waiting screen", async () => {
    $asks.set([{ code: INVITE.code, status: "waiting" }]);
    join.openLink(LINK);
    await settle();
    expect($join.get().state).toBe("waitingForAnswer");
  });

  test("an accepted answer opens the album", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    join.answerArrived(INVITE.code, "accepted", "f7");
    await settle();
    expect(mocks.open).toHaveBeenCalledWith("/albums/f7");
  });

  test("a declined answer shows the not-accepted screen", async () => {
    mocks.ask.mockResolvedValue([null, {}]);
    join.openLink(LINK);
    await settle();
    join.askToJoin();
    await settle();
    join.answerArrived(INVITE.code, "declined");
    await settle();
    expect($join.get().state).toBe("declined");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  test("a garbled link shows an error and no invite", async () => {
    join.openLink("not a link");
    await settle();
    expect($join.get().invite).toBeNull();
  });
});
