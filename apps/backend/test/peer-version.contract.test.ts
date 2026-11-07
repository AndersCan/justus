import { cases } from "./contracts/peer-version.contract.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { realVersionWorlds } from "./real-version-world.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("real", () => {
  let worlds: Awaited<ReturnType<typeof realVersionWorlds>>;
  beforeAll(async () => {
    worlds = await realVersionWorlds();
  });
  afterAll(async () => {
    await worlds.destroy();
  });

  for (const c of cases) {
    it(
      c.name,
      async () => {
        const world = worlds.world();
        try {
          await c.run(world, makeCheck());
        } finally {
          await world.close();
        }
      },
      45_000,
    );
  }
});
