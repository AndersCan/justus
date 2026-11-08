// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({
  folders: vi.fn(),
  requests: vi.fn(),
  status: vi.fn(),
  makeViewer: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    requests: mock.requests,
    status: mock.status,
    ask: vi.fn(),
    joinOffer: vi.fn(),
    createFolder: vi.fn(),
    removeMember: vi.fn(async () => [null, { ok: true }]),
    makeMember: vi.fn(async () => [null, { ok: true }]),
    makeViewer: mock.makeViewer,
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

async function startOn(path: string) {
  vi.resetModules();
  history.replaceState(null, "", path);
  await import("./albums");
  return import("../machines/people-machine");
}

describe("the app's start page and the people machine", () => {
  beforeEach(() => {
    mock.folders.mockResolvedValue([null, { folders: [], activeId: null }]);
    mock.requests.mockResolvedValue([null, { requests: [] }]);
    mock.status.mockResolvedValue([null, {}]);
    mock.makeViewer.mockResolvedValue([null, { ok: true }]);
  });

  test("the app starting on an album's members page opens its people", async () => {
    const { people, peopleActor } = await startOn("/sharing/a1");
    expect(peopleActor.snapshot().path[0]).toBe("showingPeople");
    people.makeViewer("a1", "k1");
    await vi.waitFor(() => expect(mock.makeViewer).toHaveBeenCalledWith("a1", "k1"));
  });

  test("the app starting elsewhere leaves them closed", async () => {
    const { peopleActor } = await startOn("/");
    expect(peopleActor.snapshot().path[0]).toBe("peopleSheetClosed");
  });
});
