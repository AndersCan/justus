import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps } from "./fakes/fake-store-deps.ts";
import type { Drive } from "../src/ports/drive-store.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(done: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const pushes: string[] = [];
  const refs = new Map<string, number>();
  const base = fakeStoreDeps({
    hub,
    node,
    deviceName,
    server,
    onChanged: (e: { cause: string }) => pushes.push(e.cause),
  } as never);
  const drives = base.drives;
  const counted = Object.create(drives);
  counted.open = async (key: string, opts: unknown) => {
    const r = await drives.open(key, opts as never);
    if (r[0] === null) refs.set(key, (refs.get(key) ?? 0) + 1);
    return r;
  };
  counted.release = async (d: Drive) => {
    refs.set(d.key, (refs.get(d.key) ?? 0) - 1);
    return drives.release(d);
  };
  const deps = { ...base, drives: counted };
  return { deps, node, server, pushes, refs, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
const identityOf = (s: Phone) => (s.store.debugState() as { identityDrive: string }).identityDrive;
async function letIn(admin: Phone, folderId: string, code: string, who: Phone) {
  await who.store.ask({ code, owner: identityOf(admin) });
  let requesterKey = "";
  await until(async () => {
    requesterKey = (await admin.store.requests()).requests[0]?.requesterKey ?? "";
    return requesterKey !== "";
  });
  expect((await admin.store.respond(folderId, requesterKey, true, "member"))[0]).toBeNull();
  await until(async () => (await who.store.folders()).folders.length > 0);
}
const has = async (p: Phone, name: string) =>
  (await p.store.list({ all: true })).some((x) => x.name === name);

describe("a phone follows someone let in after it, without extra work", () => {
  it("a phone with every listed drive open does not re-read its members when the Admin adds photos", async () => {
    const hub = createFakeHub();
    const anna = phone(hub, "Anna");
    const nils = phone(hub, "Nils");
    const ben = phone(hub, "Ben");
    for (const p of [anna, nils, ben]) await p.store.ready();
    const { id: folderId, invite } = (await anna.store.createFolder("Trip"))[1]!.folder;
    await letIn(anna, folderId, invite!.code, nils);
    await letIn(anna, folderId, invite!.code, ben);
    const benFolder = (await ben.store.folders()).folders[0]!.id;
    await ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3, 4]), benFolder);
    await until(() => has(nils, "ben.jpg"));
    expect(await has(nils, "ben.jpg")).toBe(true);
    await sleep(1_500);
    const before = nils.pushes.filter((c) => c === "enroll").length;
    for (const n of ["a1.jpg", "a2.jpg", "a3.jpg"]) {
      await anna.store.addBytes(n, new Uint8Array([7, 7, 7]), folderId);
      await sleep(600);
    }
    await until(() => has(nils, "a3.jpg"));
    await sleep(1_000);
    expect(nils.pushes.filter((c) => c === "enroll").length - before).toBe(0);
    // no drive is held twice by Nils
    for (const [k, n] of nils.refs) expect([k, n <= 1]).toEqual([k, true]);
    for (const p of [anna, nils, ben]) await p.store.close();
  }, 20_000);
});

describe("overlapping member refreshes", () => {
  it("a restart while drives open slowly holds each member drive once", async () => {
    const hub = createFakeHub({ readyDelayMs: () => 400 });
    const anna = phone(hub, "Anna");
    const nils = phone(hub, "Nils");
    const ben = phone(hub, "Ben");
    for (const p of [anna, nils, ben]) await p.store.ready();
    const { id: folderId, invite } = (await anna.store.createFolder("Trip"))[1]!.folder;
    await letIn(anna, folderId, invite!.code, nils);
    await letIn(anna, folderId, invite!.code, ben);
    const benFolder = (await ben.store.folders()).folders[0]!.id;
    await ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3, 4]), benFolder);
    await until(() => has(nils, "ben.jpg"));
    await nils.store.close();
    const { restarted } = await import("./fakes/fake-store-deps.ts");
    const base = restarted(nils.deps as never);
    const refs = new Map<string, number>();
    const drives = base.drives;
    const counted = Object.create(drives);
    counted.open = async (key: string, opts: unknown) => {
      const r = await drives.open(key, opts as never);
      if (r[0] === null) refs.set(key, (refs.get(key) ?? 0) + 1);
      return r;
    };
    counted.release = async (d: Drive) => {
      refs.set(d.key, (refs.get(d.key) ?? 0) - 1);
      return drives.release(d);
    };
    const nils2 = createPhotoStore({ ...base, drives: counted });
    await nils2.ready();
    await until(
      async () => (await nils2.list({ all: true })).some((x) => x.name === "ben.jpg"),
      10_000,
    );
    for (let i = 0; i < 3; i++) {
      await anna.store.addBytes(`a${i}.jpg`, new Uint8Array([i]), folderId);
      await sleep(500);
    }
    await sleep(2_000);
    for (const [k, n] of refs) expect([k, n <= 1]).toEqual([k, true]);
    for (const p of [anna.store, nils2, ben.store]) await p.close();
  }, 40_000);
});
