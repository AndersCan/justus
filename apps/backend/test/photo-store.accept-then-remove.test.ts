/** Remove right after Accept: the removed person's drive is not loaded back once Remove is done. */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { addFakeNode, createFakeHub, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

describe("removing a person right after accepting them", () => {
  it("leaves no drive of theirs open once both are done", async () => {
    const hub = createFakeHub();
    const slow = new Set<string>();
    const adaNode = addFakeNode(hub);
    setFakeNodeConnected({ hub, node: adaNode, connected: true });
    const base = fakeStoreDeps({ hub, node: adaNode });
    const adaDeps = fakeStoreDeps({
      drives: {
        ...base.drives,
        // The new phone's drive takes a while to be found, then opens.
        open: async (key: string, opts: { timeoutMs: number }) => {
          if (slow.has(key)) await sleep(1_500);
          return base.drives.open(key, opts);
        },
      },
      hub,
      node: adaNode,
      deviceName: "Ada",
    });
    mkdirSync(adaDeps.cacheDir, { recursive: true });
    const ada = createPhotoStore(adaDeps);
    const benNode = addFakeNode(hub);
    setFakeNodeConnected({ hub, node: benNode, connected: true });
    const benDeps = fakeStoreDeps({ hub, node: benNode, deviceName: "Ben" });
    mkdirSync(benDeps.cacheDir, { recursive: true });
    const ben = createPhotoStore(benDeps);
    await Promise.all([ada.ready(), ben.ready()]);
    const created = await ada.createFolder("Trip");
    const { id, invite } = created[1]!.folder;
    const owner = (ada.debugState() as { identityDrive: string }).identityDrive;
    await ben.ask({ code: invite!.code, owner });
    let key = "";
    await until(async () => {
      key = (await ada.requests()).requests[0]?.requesterKey ?? "";
      return key !== "";
    });
    slow.add(key);
    expect((await ada.respond(id, key, true, "member"))[0]).toBeNull();
    expect((await ada.removeMember(id, key))[0]).toBeNull();
    await sleep(2_500);
    const open = (
      ada.debugState() as { remoteDrives: { role: string; key: string }[] }
    ).remoteDrives.filter((d) => d.role === "member" && d.key === key);
    expect(open).toHaveLength(0);
    await Promise.all([ada.close(), ben.close()]);
  });
});
