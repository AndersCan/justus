/**
 * A Viewer's phone opens a new Viewer's drive when the Admin's Viewers list gains them. Two
 * Viewers never meet unless one opens the other's drive, so on a quiet album nothing else re-runs
 * presence. Three phones on the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check()) && Date.now() < deadline) await sleep(20);
  expect(await check()).toBe(true);
}

/** `opened` collects every drive key this phone opens. While `slow.on` is set, this phone reads the Viewers list late, so every presence pass that starts before the read ends sees the old list. */
function phone(
  hub: ReturnType<typeof createFakeHub>,
  deviceName: string,
  watch?: { opened: string[]; slow: { on: boolean } },
) {
  const deps = fakeStoreDeps({ hub, deviceName });
  if (watch) {
    const open = deps.drives.open.bind(deps.drives);
    deps.drives.open = async (key: string, opts: { timeoutMs: number }) => {
      watch.opened.push(key);
      const [err, drive] = await open(key, opts);
      if (err || !drive) return [err, drive] as never;
      const readSmall = drive.readSmall.bind(drive);
      drive.readSmall = async (path: string, max: number) => {
        if (watch.slow.on && path.includes("viewers")) await sleep(1_500);
        return readSmall(path, max);
      };
      return [null, drive];
    };
  }
  return createPhotoStore(deps);
}

describe("a Viewer's phone and a new Viewer", () => {
  it("opens the new Viewer's drive once the Admin lists them", async () => {
    const hub = createFakeHub();
    const watch = { opened: [] as string[], slow: { on: false } };
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben", watch);
    const cy = phone(hub, "Cy");
    await Promise.all([ada.ready(), ben.ready(), cy.ready()]);
    const created = (await ada.createFolder("Trip"))[1]!.folder;
    const benKey = await joinAsMember(ada, created.id, ben, created.shareKey);
    expect((await ada.makeViewer(created.id, benKey))[0]).toBeNull();
    await until(
      async () =>
        (await ben.folders()).folders.find((f) => f.shareKey === created.shareKey)?.role ===
        "reader",
    );
    await sleep(600);
    const cyKey = await joinAsMember(ada, created.id, cy, created.shareKey);
    await sleep(600);
    watch.opened.length = 0;
    watch.slow.on = true;

    expect((await ada.makeViewer(created.id, cyKey))[0]).toBeNull();
    await until(() => watch.opened.includes(cyKey));

    await Promise.all([ada.close(), ben.close(), cy.close()]);
  }, 15_000);
});
