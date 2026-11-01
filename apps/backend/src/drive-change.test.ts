import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { onDriveChange } from "./drive-change";

const dirs: string[] = [];
const stores: InstanceType<typeof Corestore>[] = [];
function store() {
  const dir = mkdtempSync(path.join(tmpdir(), "justus-drive-change-"));
  dirs.push(dir);
  const s = new Corestore(dir);
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("onDriveChange", () => {
  it("fires when a remote write replicates in (Hyperdrive emits no 'update')", async () => {
    const a = store();
    const b = store();
    const writer = new Hyperdrive(a);
    await writer.ready();
    const reader = new Hyperdrive(b, writer.key);
    await reader.ready();
    const s1 = a.replicate(true);
    const s2 = b.replicate(false);
    s1.pipe(s2).pipe(s1);

    let changes = 0;
    let legacy = 0;
    const off = onDriveChange(reader, () => changes++);
    reader.on("update", () => legacy++);

    await writer.put("/folder.json", Buffer.from("{}"));
    await reader.update({ wait: true });
    expect(reader.version).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(0);
    expect(legacy).toBe(0);

    off();
    const before = changes;
    await writer.put("/photos/x.jpg", Buffer.from("x"));
    await reader.update({ wait: true });
    expect(changes).toBe(before);

    s1.destroy();
    s2.destroy();
  });
});
