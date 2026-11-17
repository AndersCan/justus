import { describe, expect, test } from "vite-plus/test";
import { CoreError } from "@ekrooh/bare/core";
import type { SeenRecord } from "@justus/core";
import { createSeenPlugin } from "./seen-plugin";
import type { SeenStore } from "./seen-store";

function invoke(
  plugin: ReturnType<typeof createSeenPlugin>,
  event: string,
  args: Record<string, unknown>,
) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke(event, args, { runtime: "bare", payload: new Uint8Array() });
}

describe("justus.seen plugin", () => {
  test("write then read round-trip through the store", async () => {
    let kept: SeenRecord = { version: 1, known: {} };
    const store: SeenStore = {
      read: () => [null, kept],
      write: async (r) => {
        kept = r;
        return [null, {}];
      },
    };
    const plugin = createSeenPlugin({ store });
    const seen: SeenRecord = { version: 1, lastAlbum: "a", known: { a: ["p"] } };
    expect(await invoke(plugin, "seen.write", { seen })).toEqual([null, {}]);
    expect(await invoke(plugin, "seen.read", {})).toEqual([null, { seen }]);
  });

  test("store errors pass through", async () => {
    const e = new CoreError("justus.seen/write-failed", "no");
    const store: SeenStore = { read: () => [e, null], write: async () => [e, null] };
    const plugin = createSeenPlugin({ store });
    expect(await invoke(plugin, "seen.read", {})).toEqual([e, null]);
    expect(await invoke(plugin, "seen.write", { seen: { version: 1, known: {} } })).toEqual([
      e,
      null,
    ]);
  });
});
