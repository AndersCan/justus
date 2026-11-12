/**
 * Edge cases of the drop pass: start-up with no sync, a still-listed photo's thumbnail,
 * and a delete that lands while a pass is running.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { parseSpoolName } from "../src/spool-name.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  let ok = await check();
  while (!ok && Date.now() < deadline) {
    await sleep(20);
    ok = await check();
  }
  expect(ok).toBe(true);
}

type Hub = ReturnType<typeof createFakeHub>;
type Store = ReturnType<typeof createPhotoStore>;

function phoneDeps(hub: Hub, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return deps;
}

/** Holds the next `clearDeleted` answer (computed at call time) until `release()`. */
function gateClearDeleted(deps: ReturnType<typeof phoneDeps>) {
  const gate = { armed: false, hit: false, release: () => {} };
  const patched = new WeakSet<Drive>();
  const open = deps.drives.open.bind(deps.drives);
  deps.drives.open = (async (key: string, opts: { timeoutMs: number }) => {
    const r = await open(key, opts);
    const drive = r[1];
    if (drive && !patched.has(drive)) {
      patched.add(drive);
      const real = drive.clearDeleted.bind(drive);
      drive.clearDeleted = async (o: Parameters<typeof real>[0]) => {
        const answer = await real(o);
        if (gate.armed) {
          gate.armed = false;
          gate.hit = true;
          await new Promise<void>((done) => (gate.release = done));
        }
        return answer;
      };
    }
    return r;
  }) as typeof deps.drives.open;
  return gate;
}

async function album(opts: { gateNils?: boolean } = {}) {
  const hub = createFakeHub();
  const annaDeps = phoneDeps(hub, "Anna");
  const anna = createPhotoStore(annaDeps);
  const nilsDeps = phoneDeps(hub, "Nils");
  const gate = opts.gateNils ? gateClearDeleted(nilsDeps) : undefined;
  const nils = createPhotoStore(nilsDeps);
  await anna.ready();
  await nils.ready();
  const created = await anna.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const nilsKey = await joinAsMember(anna, folderId, nils, shareKey);
  const nilsFolderId = (await nils.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
  await nils.setActive(nilsFolderId);
  await anna.setActive(folderId);
  return { hub, anna, nils, annaDeps, nilsDeps, folderId, nilsFolderId, shareKey, gate, nilsKey };
}

async function addWithThumb(
  store: Store,
  deps: { cacheDir: string },
  folderId: string,
  name: string,
  seed: number,
) {
  const display = join(deps.cacheDir, `${name}-display.jpg`);
  const thumb = join(deps.cacheDir, `${name}-thumb.jpg`);
  writeFileSync(display, new Uint8Array([seed, seed + 1, seed + 2]));
  writeFileSync(thumb, new Uint8Array([seed + 10, seed + 11]));
  await store.add(display, name, folderId, { thumb });
}

async function load(deps: { server: unknown }, store: Store, name: string) {
  const photo = (await store.list()).find((p) => p.name === name)!;
  const server = deps.server as FakeLoopbackServer;
  await server.getForTest(new URL(photo.url).pathname);
  await server.getForTest(new URL(photo.thumbUrl!).pathname);
  return photo;
}

function spool(cacheDir: string, folderId: string) {
  try {
    return readdirSync(join(cacheDir, "photos", folderId)).map((n) => parseSpoolName(n));
  } catch {
    return [];
  }
}
const spoolIds = (cacheDir: string, folderId: string) =>
  spool(cacheDir, folderId).map((p) => p?.id);

describe("drop pass edges", () => {
  it("drops the stored bytes at start-up with no sync after it", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "gone.jpg", 1);
    await until(async () => (await s.nils.list()).length === 1);
    const gone = await load(s.nilsDeps, s.nils, "gone.jpg");
    const annaKey = gone.member.key;
    const [, annaDrive] = await s.nilsDeps.drives.open(annaKey, { timeoutMs: 1_000 });
    const before = annaDrive!.version();
    const path = `/photos/${gone.id}.jpg`;
    await s.nils.close();
    await s.anna.remove(gone.id); // reaches Nils's node storage: the node is still connected
    await sleep(50);
    await s.anna.close();
    setFakeNodeConnected({ hub: s.hub, node: s.annaDeps.node, connected: false });
    setFakeNodeConnected({ hub: s.hub, node: s.nilsDeps.node, connected: false });
    const deps = restarted(s.nilsDeps);
    const [, early] = await deps.drives.openAt(annaKey, before, { timeoutMs: 500 });
    expect(await early!.readSmall(path, 100, { timeoutMs: 200 })).toBeDefined(); // still here before the app starts
    const again = createPhotoStore(deps);
    await again.ready();
    await until(async () => {
      await again.list(); // the app lists the open album at start-up
      const [, past] = await deps.drives.openAt(annaKey, before, { timeoutMs: 500 });
      return (await past!.readSmall(path, 100, { timeoutMs: 200 })) === undefined;
    });
    await again.close();
  }, 20_000);

  it("keeps the thumbnail and full copy of a photo the album still has", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "gone.jpg", 1);
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "stays.jpg", 40);
    await until(async () => (await s.nils.list()).length === 2);
    const gone = await load(s.nilsDeps, s.nils, "gone.jpg");
    const stays = await load(s.nilsDeps, s.nils, "stays.jpg");
    await s.anna.remove(gone.id);
    await until(() => !spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId).includes(gone.id));
    await sleep(500);
    const exts = spool(s.nilsDeps.cacheDir, s.nilsFolderId)
      .filter((p) => p?.id === stays.id)
      .map((p) => p!.ext)
      .sort();
    expect(exts).toEqual([".jpg", "thumb.jpg"]);
    await s.anna.close();
    await s.nils.close();
  });

  it("a delete that lands while a pass runs is dropped by one more pass", async () => {
    const s = await album({ gateNils: true });
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "first.jpg", 1);
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "second.jpg", 40);
    await until(async () => (await s.nils.list()).length === 2);
    const first = await load(s.nilsDeps, s.nils, "first.jpg");
    const second = await load(s.nilsDeps, s.nils, "second.jpg");
    await sleep(1_000); // let start-up and load passes settle
    s.gate!.armed = true;
    await s.anna.remove(first.id);
    await until(() => s.gate!.hit);
    await s.anna.remove(second.id);
    await sleep(800); // Nils's change handler (400 ms debounce) asks for a pass while one runs
    s.gate!.release();
    await until(() => {
      const ids = spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId);
      return !ids.includes(first.id) && !ids.includes(second.id);
    }, 3_000);
    await s.anna.close();
    await s.nils.close();
  }, 20_000);
});
