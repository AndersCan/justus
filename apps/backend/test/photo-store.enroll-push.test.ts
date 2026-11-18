/** Accepting a person answers and lists them at once; it does not wait for their drive to open (up to the open timeout). */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import { addFakeNode, createFakeHub, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("enrolling a person whose phone is slow to answer", () => {
  it("answers the accept before the new phone's drive has opened", async () => {
    const slow = new Set<string>();
    const hub = createFakeHub({ readyDelayMs: (key) => (slow.has(key) ? Infinity : 0) });
    const changes: { cause: string; memberKey?: string }[] = [];
    const adminNode = addFakeNode(hub);
    setFakeNodeConnected({ hub, node: adminNode, connected: true });
    const base = fakeStoreDeps({ hub, node: adminNode });
    const adminDeps = fakeStoreDeps({
      drives: {
        ...base.drives,
        // A drive that is still being found: its listing never answers.
        open: async (key: string, opts: { timeoutMs: number }) => {
          const [e, drive] = await base.drives.open(key, opts);
          if (e || !slow.has(key)) return [e, drive];
          return [null, { ...drive, list: () => new Promise<never>(() => {}) } as unknown as Drive];
        },
      },
      hub,
      node: adminNode,
      deviceName: "Ada",
      driveOpenTimeoutMs: 2_000,
      onChanged: (c) => changes.push(c as { cause: string; memberKey?: string }),
    });
    mkdirSync(adminDeps.cacheDir, { recursive: true });
    const admin = createPhotoStore(adminDeps);
    const joinerNode = addFakeNode(hub);
    setFakeNodeConnected({ hub, node: joinerNode, connected: true });
    const joinerDeps = fakeStoreDeps({ hub, node: joinerNode, deviceName: "Ben" });
    mkdirSync(joinerDeps.cacheDir, { recursive: true });
    const joiner = createPhotoStore(joinerDeps);
    await Promise.all([admin.ready(), joiner.ready()]);
    const created = await admin.createFolder("Trip");
    const { id, shareKey } = created[1]!.folder;
    await joiner.join(shareKey);
    const pending = (await joiner.folders()).folders.find((f) => f.shareKey === shareKey)!;
    slow.add(pending.driveKey);
    changes.length = 0;
    const started = Date.now();
    const answered = await admin.respond(id, pending.driveKey, true);
    expect(answered[0]).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(changes.some((c) => c.cause === "enroll" && c.memberKey === pending.driveKey)).toBe(
      true,
    );
    const shown = Date.now();
    expect(
      (await admin.status()).members.some((m: { key: string }) => m.key === pending.driveKey),
    ).toBe(true);
    expect(Date.now() - shown).toBeLessThan(3_500);
    await sleep(2_500);
    // Once the drive has been given up on, the screen is told again.
    expect(
      changes.filter((c) => c.cause === "enroll" && c.memberKey === pending.driveKey),
    ).toHaveLength(2);
    await Promise.all([admin.close(), joiner.close()]);
  });
});
