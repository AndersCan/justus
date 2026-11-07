import createTestnet from "hyperdht/testnet";
import Corestore from "corestore";
import Hyperswarm from "hyperswarm";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionNode, VersionWorld } from "./contracts/peer-version.contract.ts";
import { trackTmpPath } from "./tmp-dirs.ts";
import { makeVersionNode } from "./version-node.ts";

export async function realVersionWorlds(): Promise<{
  world(): VersionWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: VersionWorld[] = [];
  return {
    world() {
      const nodes: VersionNode[] = [];
      const w: VersionWorld = {
        async node(own) {
          const dir = trackTmpPath(mkdtempSync(join(tmpdir(), "justus-version-")));
          const node = makeVersionNode(
            {
              Corestore: Corestore as never,
              Hyperswarm: Hyperswarm as never,
              bootstrap: testnet.bootstrap,
            },
            dir,
            own,
          );
          nodes.push(node);
          return node;
        },
        topic: () => randomBytes(32).toString("hex"),
        async close() {
          for (const n of nodes) await n.close().catch(() => {});
        },
      };
      worlds.push(w);
      return w;
    },
    async destroy() {
      for (const w of worlds) await w.close();
      await testnet.destroy();
    },
  };
}
