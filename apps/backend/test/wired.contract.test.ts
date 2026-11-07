// Real only: the fake drive store replicates per node, not per connection.
import { cases } from "./contracts/wired.contract.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { realWiredWorlds } from "./real-peers.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("real", () => {
  let worlds: Awaited<ReturnType<typeof realWiredWorlds>>;
  beforeAll(async () => {
    worlds = await realWiredWorlds();
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
