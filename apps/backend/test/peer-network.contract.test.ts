import { cases } from "./contracts/peer-network.contract.ts";
import { fakePeerWorlds } from "./fakes/fake-world.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { realPeerWorlds } from "./real-peers.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("real", () => {
  let worlds: Awaited<ReturnType<typeof realPeerWorlds>>;
  beforeAll(async () => {
    worlds = await realPeerWorlds();
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
      30_000,
    );
  }
});

describe("fake", () => {
  const worlds = fakePeerWorlds();

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
      30_000,
    );
  }
});
