import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { expect, test } from "vite-plus/test";

const script = join(import.meta.dirname, "check-aab-page-size.sh");
const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

// Minimal zip writer (stored entries only).
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// The .so "content" is the readelf output the stub prints for it.
function run(entries: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "aab-"));
  const stub = join(dir, "readelf");
  writeFileSync(stub, '#!/usr/bin/env bash\ncat "$2"\n');
  chmodSync(stub, 0o755);
  const aab = join(dir, "app.aab");
  writeFileSync(aab, zip(entries));
  return spawnSync("bash", [script, aab], {
    encoding: "utf8",
    env: { ...process.env, READELF: stub },
  });
}

const load = (align: string) =>
  `  LOAD 0x000000 0x0000000000000000 0x0000000000000000 0x001000 0x001000 R E ${align}\n`;

test.skipIf(!hasUnzip)("passes when every LOAD segment is 0x4000", () => {
  const r = run({
    "base/lib/arm64-v8a/liba.so": load("0x4000") + load("0x4000"),
    "base/lib/x86_64/liba.so": load("0x4000"),
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("arm64-v8a/liba.so LOAD align 0x4000");
});

test.skipIf(!hasUnzip)("fails when a LOAD segment is 0x1000", () => {
  const r = run({
    "base/lib/arm64-v8a/liba.so": load("0x4000"),
    "base/lib/x86_64/libnativehelper.so": load("0x4000") + load("0x1000"),
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("below 0x4000");
});

test.skipIf(!hasUnzip)("fails when a .so has no LOAD segments", () => {
  const r = run({ "base/lib/arm64-v8a/liba.so": "no program headers\n" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("no LOAD segments");
});

test.skipIf(!hasUnzip)("fails when there are no 64-bit .so files", () => {
  const r = run({ "base/lib/armeabi-v7a/liba.so": load("0x1000") });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("no 64-bit .so files");
});
