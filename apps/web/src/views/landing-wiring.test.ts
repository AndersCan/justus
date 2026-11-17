// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";

const mock = vi.hoisted(() => ({ folders: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    seen: { read: mock.read, write: mock.write },
    requests: vi.fn(async () => [null, { requests: [] }]),
    status: vi.fn(async () => [null, {}]),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

const listed = (ids: string[]) => [
  null,
  { folders: ids.map((id) => ({ id, name: id, kind: "owned" })), activeId: null },
];

async function boot(path: string, read: Promise<unknown>) {
  vi.resetModules();
  history.replaceState(null, "", path);
  mock.read.mockReturnValue(read);
  mock.write.mockResolvedValue([null, {}]);
  mock.folders.mockResolvedValue(listed(["f1"]));
  const { foldersActor, folders } = await import("../machines/folders-machine");
  const { open } = await import("../machines/router-machine");
  const { landOnLastAlbum } = await import("./landing");
  landOnLastAlbum({ appStart: true });
  folders.refresh();
  await vi.waitFor(() => expect(foldersActor.snapshot().context.folders.length).toBe(1));
  return { foldersActor, folders, open };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const record = [null, { seen: { version: 1, known: {}, lastAlbum: "f1" } }];

test("a seen file read after the album list still lands", async () => {
  let resolve: (v: unknown) => void = () => {};
  await boot("/", new Promise((r) => (resolve = r)));
  await settle();
  expect(location.pathname).toBe("/");
  resolve(record);
  await settle();
  expect(location.pathname).toBe("/albums/f1");
});

test("a start through /welcome lands once the page moves to /", async () => {
  const { open } = await boot("/welcome", Promise.resolve(record));
  await settle();
  expect(location.pathname).toBe("/welcome");
  open("/", { replace: true });
  await settle();
  expect(location.pathname).toBe("/albums/f1");
});

test("lands once: going back to All photos is not undone by a later list", async () => {
  const { open, folders } = await boot("/", Promise.resolve(record));
  await settle();
  expect(location.pathname).toBe("/albums/f1");
  open("/");
  folders.refresh();
  await settle();
  expect(location.pathname).toBe("/");
});

test("a tab tapped between the decision and the open wins", async () => {
  vi.resetModules();
  history.replaceState(null, "", "/");
  mock.read.mockResolvedValue(record);
  mock.folders.mockResolvedValue(listed(["f1"]));
  const { foldersActor, folders } = await import("../machines/folders-machine");
  const { open } = await import("../machines/router-machine");
  const { seenActor } = await import("../machines/seen-machine");
  const { landOnLastAlbum } = await import("./landing");
  await vi.waitFor(() => expect(seenActor.snapshot().context.status).toBe("ready"));
  landOnLastAlbum({ appStart: true });
  let tapped = false;
  foldersActor.on("change", {
    fn: () => {
      if (!tapped && foldersActor.snapshot().context.folders.length > 0) {
        tapped = true;
        open("/settings");
      }
    },
  });
  folders.refresh();
  await settle();
  expect(location.pathname).toBe("/settings");
});

test("an open invite keeps the start on /", async () => {
  vi.resetModules();
  history.replaceState(null, "", "/");
  mock.read.mockResolvedValue(record);
  mock.write.mockResolvedValue([null, {}]);
  mock.folders.mockResolvedValue(listed(["f1"]));
  const { join, joinActor } = await import("../machines/sharing/join-request");
  const { foldersActor, folders } = await import("../machines/folders-machine");
  const { landOnLastAlbum } = await import("./landing");
  join.reopenRequest({
    code: "c1",
    owner: "anna-id",
    ownerName: "Anna",
    albumName: "Summer trip",
    status: "waiting",
    askedAt: 0,
  } as never);
  await vi.waitFor(() => expect(joinActor.snapshot().path[0]).not.toBe("noInviteOpen"));
  landOnLastAlbum({ appStart: true });
  folders.refresh();
  await vi.waitFor(() => expect(foldersActor.snapshot().context.folders.length).toBe(1));
  await settle();
  expect(location.pathname).toBe("/");
});
