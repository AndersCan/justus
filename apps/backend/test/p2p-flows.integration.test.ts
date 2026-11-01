/**
 * Every multi-device flow over a real swarm (#200), under Node. The scenarios
 * live in `p2p-scenarios.ts` and also run inside Bare (`pnpm test:bare`).
 */
import { afterEach, describe, it } from "vite-plus/test";
import { makeCheck, scenarios } from "./p2p-scenarios.ts";
import { realNet, type Net } from "./real-peers.ts";

let net: Net | undefined;
afterEach(async () => {
  await net?.destroy();
  net = undefined;
});

describe("p2p flows over a real swarm", () => {
  for (const s of scenarios) {
    it(
      s.name,
      async () => {
        net = await realNet();
        await s.run(net, makeCheck());
      },
      60_000,
    );
  }
});
