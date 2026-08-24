import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import { spoolNameFor } from "./spool-name";

describe("spoolNameFor (issue #71 — path traversal)", () => {
  test("produces a token with no path separators or '..' segments", () => {
    const maliciousId = "../../../../etc/cron.d/payload";
    const name = spoolNameFor("abcdef0123456789", maliciousId, ".png");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
  });

  test("keeps the resolved spool path inside the spool directory", () => {
    const spoolDir = path.resolve("/var/justus/cache/photos/folder1");
    const maliciousId = "../../../../etc/cron.d/payload";
    const name = spoolNameFor("abcdef0123456789", maliciousId, ".png");
    const spoolPath = path.resolve(spoolDir, name);
    expect(spoolPath.startsWith(spoolDir + path.sep)).toBe(true);
  });

  test("is deterministic and unique per input", () => {
    const a = spoolNameFor("k1", "idA", ".jpg");
    const b = spoolNameFor("k1", "idA", ".jpg");
    const c = spoolNameFor("k1", "idB", ".jpg");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("encodes attacker-controlled extensions without escaping", () => {
    const name = spoolNameFor("abcdef0123456789", "photo", "/../../../../root/.bashrc");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
  });
});
