/** A phone that had not followed a handover when the new Admin's move offer arrives still follows the move. */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";
import type { Drive } from "../src/ports/drive-store.ts";

type Ev = { event: string; fields: Record<string, unknown> };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}
function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, logs: Ev[] = []) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  deps.log = (e: Ev) => logs.push(e);
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip");

/** Eve reads no `/admin.json` on `key` while `held.on`: she has not seen the handover yet. */
function holdAdminNote(eve: Phone, key: () => string, held: { on: boolean; gate?: Promise<void> }) {
  const drives = eve.deps.drives;
  const open = drives.open.bind(drives);
  drives.open = (async (...args: Parameters<typeof drives.open>) => {
    const [err, drive] = await open(...args);
    if (err || !drive || args[0] !== key()) return [err, drive];
    const wrapped = new Proxy(drive, {
      get(target, prop) {
        if (prop !== "readSmall") return Reflect.get(target, prop);
        return async (path: string, ...rest: unknown[]) => {
          const gate = path === "/admin.json" ? held.gate : undefined;
          held.gate = gate ? undefined : held.gate;
          if (gate) await gate;
          if (held.on && path === "/admin.json") return undefined;
          return (target.readSmall as (...a: unknown[]) => unknown)(path, ...rest);
        };
      },
    }) as Drive;
    return [null, wrapped];
  }) as typeof drives.open;
}

const identityOf = (p: Phone) => (p.store.debugState() as { identityDrive: string }).identityDrive;

describe("a Viewer who has not followed the handover yet", () => {
  it("follows the new Admin's move after a Remove", async () => {
    const hub = createFakeHub();
    const eveLogs: Ev[] = [];
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    const eve = phone(hub, "Eve", eveLogs);
    let shareKey = "";
    const held = { on: true };
    holdAdminNote(eve, () => shareKey, held);
    for (const p of [ada, ben, cy, eve]) await p.store.ready();
    const created = await ada.store.createFolder("Trip");
    const { id: folderId, invite } = created[1]!.folder;
    shareKey = created[1]!.folder.shareKey;
    const keys: Record<string, string> = {};
    for (const [name, who, role] of [
      ["ben", ben, "member"],
      ["cy", cy, "member"],
      ["eve", eve, "reader"],
    ] as const) {
      await who.store.ask({ code: invite!.code, owner: identityOf(ada) });
      let requesterKey = "";
      await until(async () => {
        requesterKey = (await ada.store.requests()).requests[0]?.requesterKey ?? "";
        return requesterKey !== "";
      });
      keys[name] = requesterKey;
      expect((await ada.store.respond(folderId, requesterKey, true, role))[0]).toBeNull();
      await until(async () => (await trip(who))?.shareKey === shareKey);
    }
    await until(async () => {
      const m = (await ada.store.status()).members;
      return m.length === 4 && m.every((x: { identity?: string }) => x.identity !== undefined);
    });

    expect((await ada.store.handOver(folderId, keys.ben!))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    await sleep(500);
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    expect(eveLogs.some((e) => e.event === "admin.followed")).toBe(false);
    held.on = false;

    const benFolder = (await trip(ben))!.id;
    expect((await ben.store.removeMember(benFolder, keys.cy!))[0]).toBeNull();
    const newKey = (await trip(ben))!.shareKey;
    expect(newKey).not.toBe(shareKey);
    await until(async () => (await trip(eve))?.shareKey === newKey, 20_000);
    expect((await trip(eve))?.role).toBe("reader");
    for (const p of [ben, cy, eve, ada]) await p.store.close();
  }, 60_000);
  it("follows the move when her own read of the handover is still running as the offer comes", async () => {
    const hub = createFakeHub();
    const eveLogs: Ev[] = [];
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    const eve = phone(hub, "Eve", eveLogs);
    let shareKey = "";
    const held: { on: boolean; gate?: Promise<void> } = { on: false };
    holdAdminNote(eve, () => shareKey, held);
    for (const p of [ada, ben, cy, eve]) await p.store.ready();
    const created = await ada.store.createFolder("Trip");
    const { id: folderId, invite } = created[1]!.folder;
    shareKey = created[1]!.folder.shareKey;
    const keys: Record<string, string> = {};
    for (const [name, who, role] of [
      ["ben", ben, "member"],
      ["cy", cy, "member"],
      ["eve", eve, "reader"],
    ] as const) {
      await who.store.ask({ code: invite!.code, owner: identityOf(ada) });
      let requesterKey = "";
      await until(async () => {
        requesterKey = (await ada.store.requests()).requests[0]?.requesterKey ?? "";
        return requesterKey !== "";
      });
      keys[name] = requesterKey;
      expect((await ada.store.respond(folderId, requesterKey, true, role))[0]).toBeNull();
      await until(async () => (await trip(who))?.shareKey === shareKey);
    }
    await until(async () => {
      const m = (await ada.store.status()).members;
      return m.length === 4 && m.every((x: { identity?: string }) => x.identity !== undefined);
    });

    let open = () => {};
    held.gate = new Promise<void>((r) => (open = r));
    expect((await ada.store.handOver(folderId, keys.ben!))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    await sleep(500);
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    expect(eveLogs.some((e) => e.event === "admin.followed")).toBe(false);
    setTimeout(open, 14_000);

    const benFolder = (await trip(ben))!.id;
    expect((await ben.store.removeMember(benFolder, keys.cy!))[0]).toBeNull();
    const newKey = (await trip(ben))!.shareKey;
    expect(newKey).not.toBe(shareKey);
    await until(async () => (await trip(eve))?.shareKey === newKey, 30_000);
    expect((await trip(eve))?.role).toBe("reader");
    for (const p of [ben, cy, eve, ada]) await p.store.close();
  }, 90_000);
});
