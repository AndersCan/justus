import { cases } from "./contracts/drive-store.contract.ts";
import { fakeDriveWorlds } from "./fakes/fake-world.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { realDriveWorlds } from "./real-peers.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("real", () => {
  let worlds: Awaited<ReturnType<typeof realDriveWorlds>>;
  beforeAll(async () => {
    worlds = await realDriveWorlds();
  });
  afterAll(async () => {
    await worlds.destroy();
  });

  for (const c of cases) {
    it(c.name, () => c.run(worlds.world(), makeCheck()), 30_000);
  }
});

describe("fake", () => {
  const worlds = fakeDriveWorlds();

  for (const c of cases) {
    it(c.name, () => c.run(worlds.world(), makeCheck()), 30_000);
  }
});
