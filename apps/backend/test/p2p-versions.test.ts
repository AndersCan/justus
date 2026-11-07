/**
 * The p2p library versions our assumptions were last verified against
 * (docs/adr/0001-p2p-libraries-behind-verified-boundaries.md). A lockfile or
 * dependency bump changes one of these and fails here, on purpose: before
 * updating the list, run the real-swarm suites (`vp run -r test`, the bare
 * suite, the multi-peer e2e) and re-read the library changelogs for event
 * names, open/close semantics and key types. Transitive cores (hypercore) are
 * listed because corestore's range does not pin them.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";

const VERIFIED: Record<string, string> = {
  corestore: "7.12.0",
  hyperdrive: "13.3.3",
  hyperswarm: "4.17.0",
  protomux: "3.11.0",
  hyperdht: "6.33.1",
  hypercore: "11.40.3",
};

const require = createRequire(import.meta.url);

describe("p2p library versions", () => {
  for (const [name, verified] of Object.entries(VERIFIED)) {
    it(`${name} is the verified ${verified}`, () => {
      const { version } = require(`${name}/package.json`) as { version: string };
      expect(
        version,
        `${name} moved ${verified} -> ${version}: re-verify the real-swarm suites, then update VERIFIED`,
      ).toBe(verified);
    });
  }
});
