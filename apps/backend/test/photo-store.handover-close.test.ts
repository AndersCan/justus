/** Closing the store while a move offer waits on an in-flight handover read does not read the handover again. */
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
function holdAdminNote(
  eve: Phone,
  key: () => string,
  held: { on: boolean; gate?: Promise<void>; reads?: number },
) {
  const drives = eve.deps.drives;
  const open = drives.open.bind(drives);
  drives.open = (async (...args: Parameters<typeof drives.open>) => {
    const [err, drive] = await open(...args);
    if (err || !drive || args[0] !== key()) return [err, drive];
    const wrapped = new Proxy(drive, {
      get(target, prop) {
        if (prop !== "readSmall") return Reflect.get(target, prop);
        return async (path: string, ...rest: unknown[]) => {
          if (path === "/admin.json") held.reads = (held.reads ?? 0) + 1;
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

describe("a Viewer whose phone closes", () => {
  it("does not read the handover again after her phone closes while an offer waits", async () => {
    const hub = createFakeHub();
    const eveLogs: Ev[] = [];
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    const eve = phone(hub, "Eve", eveLogs);
    let shareKey = "";
    const held: { on: boolean; gate?: Promise<void>; reads?: number } = { on: false };
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

    const benFolder = (await trip(ben))!.id;
    expect((await ben.store.removeMember(benFolder, keys.cy!))[0]).toBeNull();
    await sleep(1_500);
    const offered = eveLogs.filter((e) => e.event.startsWith("move")).map((e) => e.event);
    await eve.store.close();
    const readsAtClose = held.reads ?? 0;
    open();
    await sleep(5_000);
    for (const p of [ben, cy, ada]) await p.store.close();
    console.log("offered", offered, "reads at close", readsAtClose, "after", held.reads);
    expect((held.reads ?? 0) - readsAtClose).toBe(0);
  }, 90_000);
});
