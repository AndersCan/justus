import { cases } from "./contracts/peer-answer.contract.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { realAnswerWorlds } from "./real-answer-world.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("real", () => {
  let worlds: Awaited<ReturnType<typeof realAnswerWorlds>>;
  beforeAll(async () => {
    worlds = await realAnswerWorlds();
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
