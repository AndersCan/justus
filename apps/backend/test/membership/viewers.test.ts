import { describe, expect, it } from "vite-plus/test";
import type { Drive } from "../../src/ports/drive-store.ts";
import type { RegistryFile, ViewersFile } from "../../src/membership/records.ts";
import { makeMemberViewer, makeViewerMember, removeViewer } from "../../src/membership/viewers.ts";

const KEY = "a".repeat(64);

function fakeDrive(failOn?: string) {
  const writes: { path: string; json: unknown }[] = [];
  const drive = {
    async put(path: string, bytes: Uint8Array) {
      if (path === failOn) throw new Error("disk full");
      writes.push({ path, json: JSON.parse(Buffer.from(bytes).toString()) });
    },
  } as unknown as Drive;
  return { drive, writes };
}

const registry = (): RegistryFile => ({
  version: 1,
  members: { [KEY]: { key: KEY, name: "Nils", addedAt: 1 } },
});
const empty: ViewersFile = { version: 1, viewers: {} };
const keptViewers = (): ViewersFile => ({
  version: 1,
  viewers: { [KEY]: { key: KEY, name: "Nils", addedAt: 1, keptVersion: 3 } },
});

describe("a role change keeps addedAt", () => {
  it("Collaborator to Viewer", async () => {
    const { drive } = fakeDrive();
    const [, out] = await makeMemberViewer(drive, {
      viewers: empty,
      registry: registry(),
      memberKey: KEY,
      keptVersion: 7,
    });
    expect(out?.viewers.viewers[KEY]?.addedAt).toBe(1);
  });

  it("Viewer to Collaborator", async () => {
    const { drive } = fakeDrive();
    const [, out] = await makeViewerMember(drive, {
      viewers: keptViewers(),
      registry: { version: 1, members: {} },
      memberKey: KEY,
    });
    expect(out?.registry.members[KEY]?.addedAt).toBe(1);
  });
});

describe("makeMemberViewer", () => {
  it("writes /viewers.json with keptVersion, then /members.json without the key", async () => {
    const { drive, writes } = fakeDrive();
    const [err, out] = await makeMemberViewer(drive, {
      viewers: empty,
      registry: registry(),
      memberKey: KEY,
      keptVersion: 7,
    });
    expect(err).toBeNull();
    expect(out?.changed).toBe(true);
    expect(out?.viewers.viewers[KEY]).toMatchObject({ key: KEY, name: "Nils", keptVersion: 7 });
    expect(out?.registry.members).toEqual({});
    expect(writes.map((w) => w.path)).toEqual(["/viewers.json", "/members.json"]);
  });

  it("does not change its inputs", async () => {
    const { drive } = fakeDrive();
    const reg = registry();
    await makeMemberViewer(drive, {
      viewers: empty,
      registry: reg,
      memberKey: KEY,
      keptVersion: 1,
    });
    expect(reg).toEqual(registry());
    expect(empty.viewers).toEqual({});
  });

  it("already a Viewer and not a member: no writes, changed false", async () => {
    const { drive, writes } = fakeDrive();
    const [err, out] = await makeMemberViewer(drive, {
      viewers: keptViewers(),
      registry: { version: 1, members: {} },
      memberKey: KEY,
      keptVersion: 9,
    });
    expect(err).toBeNull();
    expect(out?.changed).toBe(false);
    expect(writes).toEqual([]);
  });

  it("in neither file: no-such-member", async () => {
    const { drive, writes } = fakeDrive();
    const [err] = await makeMemberViewer(drive, {
      viewers: empty,
      registry: { version: 1, members: {} },
      memberKey: KEY,
      keptVersion: 1,
    });
    expect(err?.kind).toBe("no-such-member");
    expect(writes).toEqual([]);
  });

  it("in both files: keeps the existing keptVersion and only rewrites the registry", async () => {
    const { drive, writes } = fakeDrive();
    const [err, out] = await makeMemberViewer(drive, {
      viewers: keptViewers(),
      registry: registry(),
      memberKey: KEY,
      keptVersion: 9,
    });
    expect(err).toBeNull();
    expect(out?.viewers.viewers[KEY].keptVersion).toBe(3);
    expect(writes.map((w) => w.path)).toEqual(["/members.json"]);
  });

  it("a failed put is write-failed; a failed first write leaves /members.json alone", async () => {
    const first = fakeDrive("/viewers.json");
    const [e1] = await makeMemberViewer(first.drive, {
      viewers: empty,
      registry: registry(),
      memberKey: KEY,
      keptVersion: 1,
    });
    expect(e1?.kind).toBe("write-failed");
    expect(first.writes).toEqual([]);
    const second = fakeDrive("/members.json");
    const [e2] = await makeMemberViewer(second.drive, {
      viewers: empty,
      registry: registry(),
      memberKey: KEY,
      keptVersion: 1,
    });
    expect(e2?.kind).toBe("write-failed");
    expect(second.writes.map((w) => w.path)).toEqual(["/viewers.json"]);
  });
});

describe("makeViewerMember", () => {
  it("drops keptVersion from the registry entry", async () => {
    const { drive } = fakeDrive();
    const [err, out] = await makeViewerMember(drive, {
      viewers: keptViewers(),
      registry: { version: 1, members: {} },
      memberKey: KEY,
    });
    expect(err).toBeNull();
    expect(Object.keys(out?.registry.members[KEY] ?? {}).sort()).toEqual([
      "addedAt",
      "key",
      "name",
    ]);
  });
});

describe("removeViewer", () => {
  it("removes only the key and leaves the input unchanged", async () => {
    const other = "b".repeat(64);
    const input: ViewersFile = {
      version: 1,
      viewers: {
        [KEY]: { key: KEY, name: "Nils", addedAt: 1 },
        [other]: { key: other, name: "Ida", addedAt: 2 },
      },
    };
    const { drive, writes } = fakeDrive();
    const [err, next] = await removeViewer(drive, { viewers: input, viewerKey: KEY });
    expect(err).toBeNull();
    expect(Object.keys(next!.viewers)).toEqual([other]);
    expect(Object.keys(input.viewers)).toEqual([KEY, other]);
    expect(writes).toHaveLength(1);
  });

  it("says no-such-viewer for an unknown key and writes nothing", async () => {
    const { drive, writes } = fakeDrive();
    const [err] = await removeViewer(drive, { viewers: empty, viewerKey: KEY });
    expect(err?.kind).toBe("no-such-viewer");
    expect(writes).toEqual([]);
  });

  it("says write-failed when the put throws", async () => {
    const { drive } = fakeDrive("/viewers.json");
    const [err] = await removeViewer(drive, { viewers: keptViewers(), viewerKey: KEY });
    expect(err?.kind).toBe("write-failed");
  });
});
