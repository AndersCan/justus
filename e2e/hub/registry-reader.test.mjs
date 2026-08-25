/**
 * Unit tests for the Playwright-free hub registry reader (issue #18).
 * Pure: no hub, no browsers, no peers — just file I/O + parsing/validation.
 */

import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  resolveInstance,
  resolveInstanceById,
  waitForRegistry,
  registryPath,
} from "./registry-reader.mjs";

const SAMPLE = {
  dht: { port: 49737, bootstrap: "http://127.0.0.1:49737" },
  instances: [
    { id: "tab-1", port: 9000, url: "http://127.0.0.1:9000", storageDir: "/s/instance-1" },
    { id: "tab-2", port: 9001, url: "http://127.0.0.1:9001", storageDir: "/s/instance-2" },
  ],
};

function tmpRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "justus-hub-"));
  const file = join(dir, "registry.json");
  return { dir, file };
}

describe("loadRegistry", () => {
  it("throws a clear error when the file is missing", () => {
    const { dir, file } = tmpRegistry();
    rmSync(dir, { recursive: true, force: true });
    expect(() => loadRegistry(file)).toThrow(/not found/);
  });

  it("throws when the file is not valid JSON", () => {
    const { dir, file } = tmpRegistry();
    writeFileSync(file, "{not json");
    expect(() => loadRegistry(file)).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when dht.bootstrap/port are missing", () => {
    const { dir, file } = tmpRegistry();
    writeFileSync(file, JSON.stringify({ dht: {}, instances: SAMPLE.instances }));
    expect(() => loadRegistry(file)).toThrow(/dht\.bootstrap/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when instances is empty", () => {
    const { dir, file } = tmpRegistry();
    writeFileSync(file, JSON.stringify({ dht: SAMPLE.dht, instances: [] }));
    expect(() => loadRegistry(file)).toThrow(/non-empty instances/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when an instance is missing id/url/port/storageDir", () => {
    const { dir, file } = tmpRegistry();
    writeFileSync(
      file,
      JSON.stringify({ dht: SAMPLE.dht, instances: [{ id: "x", url: "u", port: 1 }] }),
    );
    expect(() => loadRegistry(file)).toThrow(/instance missing/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the parsed registry for a valid file", () => {
    const { dir, file } = tmpRegistry();
    writeFileSync(file, JSON.stringify(SAMPLE));
    const reg = loadRegistry(file);
    expect(reg.dht.port).toBe(49737);
    expect(reg.instances).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveInstance", () => {
  it("resolves by 0-based index", () => {
    expect(resolveInstance(SAMPLE, 0).id).toBe("tab-1");
    expect(resolveInstance(SAMPLE, 1).url).toBe("http://127.0.0.1:9001");
  });

  it("throws on out-of-range index", () => {
    expect(() => resolveInstance(SAMPLE, -1)).toThrow(RangeError);
    expect(() => resolveInstance(SAMPLE, 2)).toThrow(RangeError);
  });
});

describe("resolveInstanceById", () => {
  it("resolves by stable id", () => {
    expect(resolveInstanceById(SAMPLE, "tab-2").port).toBe(9001);
  });

  it("throws on unknown id", () => {
    expect(() => resolveInstanceById(SAMPLE, "nope")).toThrow(/no instance with id nope/);
  });
});

describe("waitForRegistry", () => {
  it("waits until a half-written file becomes valid", async () => {
    const { dir, file } = tmpRegistry();
    // Seed with invalid content, then fix it after a short delay.
    writeFileSync(file, "{incomplete");
    const timer = setTimeout(() => writeFileSync(file, JSON.stringify(SAMPLE)), 200);

    const reg = await waitForRegistry(file, 5000);
    clearTimeout(timer);
    expect(reg.instances).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  }, 8000);

  it("rejects when the registry never appears", async () => {
    const { dir, file } = tmpRegistry();
    rmSync(dir, { recursive: true, force: true });
    await expect(waitForRegistry(file, 500)).rejects.toThrow(/did not become ready/);
  }, 8000);
});

describe("registryPath", () => {
  it("honors JUSTUS_HUB_REGISTRY override", () => {
    const prev = process.env.JUSTUS_HUB_REGISTRY;
    process.env.JUSTUS_HUB_REGISTRY = "/tmp/custom-registry.json";
    try {
      expect(registryPath()).toBe("/tmp/custom-registry.json");
    } finally {
      if (prev === undefined) delete process.env.JUSTUS_HUB_REGISTRY;
      else process.env.JUSTUS_HUB_REGISTRY = prev;
    }
  });
});
