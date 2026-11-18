/** The saved list of who left is read back name by name; a bad entry is dropped. */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

describe("loading who left", () => {
  it("keeps names in order, drops entries that are not names, and no key when none is left", async () => {
    const hub = createFakeHub();
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    const deps = fakeStoreDeps({ hub, node, deviceName: "Anna", server: new FakeLoopbackServer() });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();
    await store.createFolder("Trip");
    await store.createFolder("Day");
    await store.close();
    const file = join(deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].whoLeft = ["Ben", 7, null, "", "Cara"];
    saved.folders[1].whoLeft = [7, ""];
    writeFileSync(file, JSON.stringify(saved));
    const again = createPhotoStore(restarted(deps));
    await again.ready();
    const folders = (await again.folders()).folders;
    expect(folders.find((f) => f.name === "Trip")!.whoLeft).toEqual(["Ben", "Cara"]);
    expect("whoLeft" in folders.find((f) => f.name === "Day")!).toBe(false);
    await again.close();
  });
});
