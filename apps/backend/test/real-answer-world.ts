import createTestnet from "hyperdht/testnet";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAnswerNode } from "./answer-node.ts";
import type { AnswerNode, AnswerWorld } from "./contracts/peer-answer.contract.ts";
import { trackTmpPath } from "./tmp-dirs.ts";

export async function realAnswerWorlds(): Promise<{
  world(): AnswerWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: AnswerWorld[] = [];
  return {
    world() {
      const nodes: AnswerNode[] = [];
      const w: AnswerWorld = {
        async node() {
          const dir = trackTmpPath(mkdtempSync(join(tmpdir(), "justus-answer-")));
          const node = makeAnswerNode(
            {
              Corestore: Corestore as never,
              Hyperdrive: Hyperdrive as never,
              Hyperswarm: Hyperswarm as never,
              bootstrap: testnet.bootstrap,
            },
            dir,
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
