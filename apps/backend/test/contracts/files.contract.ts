/**
 * The Files contract (#200): behaviour of the file system the backend relies
 * on, written once and run against Node fs (vitest) and bare-fs (Bare).
 *
 * Portable on purpose: no test-runner or Node built-in imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link FilesWorld} and a `Check`.
 */
import type { Files, Paths } from "../../src/ports/files.ts";
import { pumpStream, type PumpSource } from "../../src/pump.ts";
import type { Check } from "../p2p-scenarios.ts";

export type FilesWorld = {
  fs: Files;
  path: Paths;
  /** A fresh, empty directory that exists. */
  dir: string;
  /** Creates a symlink at `link` pointing at `target` (not part of the port). */
  symlink: (target: string, link: string) => void;
};

export type FilesCase = {
  name: string;
  run(world: FilesWorld, t: Check): Promise<void>;
};

const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** A source of `count` chunks that only emits while not paused. */
function chunkSource(count: number, size: number) {
  const handlers: Record<string, (...args: any[]) => void> = {};
  let paused = false;
  let sent = 0;
  let pauses = 0;
  let scheduled = false;
  const pump = () => {
    scheduled = false;
    while (!paused && sent < count) {
      sent++;
      handlers.data?.(new Uint8Array(size).fill(7));
    }
    if (!paused && sent === count) {
      sent++;
      handlers.end?.();
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(pump, 0);
  };
  const source: PumpSource = {
    on(event, listener) {
      handlers[event] = listener;
      if (event === "end") schedule();
      return source;
    },
    pause() {
      paused = true;
      pauses++;
    },
    resume() {
      paused = false;
      schedule();
    },
  };
  return { source, pauses: () => pauses };
}

export const cases: FilesCase[] = [
  {
    name: "F1 write, read, rename and unlink a file",
    async run({ fs, path, dir }, t) {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      fs.writeFileSync(a, "hello");
      t.eq(text(fs.readFileSync(a)), "hello", "read back");
      t.eq(fs.statSync(a).size, 5, "size");
      t.eq(fs.existsSync(a), true, "exists");
      fs.renameSync(a, b);
      t.eq([fs.existsSync(a), fs.existsSync(b)], [false, true], "renamed");
      t.eq(text(fs.readFileSync(b)), "hello", "content survives rename");
      fs.unlinkSync(b);
      t.eq(fs.existsSync(b), false, "unlinked");
      t.ok(errorOf(() => fs.readFileSync(b)) !== undefined, "reading a missing file throws");
      t.ok(errorOf(() => fs.unlinkSync(b)) !== undefined, "unlinking a missing file throws");
    },
  },
  {
    name: "F2 writeFileSync overwrites and takes bytes",
    async run({ fs, path, dir }, t) {
      const p = path.join(dir, "bin");
      fs.writeFileSync(p, new Uint8Array([1, 2, 3, 4]));
      fs.writeFileSync(p, new Uint8Array([9, 8]));
      t.eq(Array.from(fs.readFileSync(p) as unknown as Uint8Array), [9, 8], "overwritten");
    },
  },
  {
    name: "F3 lstat sees a symlink and readlinkSync returns its target",
    async run({ fs, path, dir, symlink }, t) {
      const target = path.join(dir, "target.txt");
      const link = path.join(dir, "link.txt");
      fs.writeFileSync(target, "x");
      symlink(target, link);
      t.eq(fs.lstatSync(link).isSymbolicLink(), true, "lstat on the link");
      t.eq(fs.lstatSync(target).isSymbolicLink(), false, "lstat on the file");
      t.eq(fs.readlinkSync(link), target, "link target");
      t.eq(fs.statSync(link).size, 1, "stat follows the link");
    },
  },
  {
    name: "F4 mkdirSync recursive is idempotent and creates parents",
    async run({ fs, path, dir }, t) {
      const deep = path.join(dir, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      fs.mkdirSync(deep, { recursive: true });
      t.eq(fs.statSync(deep).isDirectory(), true, "created");
      fs.writeFileSync(path.join(deep, "f"), "1");
      fs.mkdirSync(deep, { recursive: true });
      t.eq(text(fs.readFileSync(path.join(deep, "f"))), "1", "existing content untouched");
    },
  },
  {
    name: "F5 readdirSync lists names and rmSync removes a tree",
    async run({ fs, path, dir }, t) {
      const tree = path.join(dir, "tree");
      fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
      fs.writeFileSync(path.join(tree, "one"), "1");
      fs.writeFileSync(path.join(tree, "sub", "two"), "2");
      t.eq([...fs.readdirSync(tree)].map(String).sort(), ["one", "sub"], "names");
      fs.rmSync(tree, { recursive: true, force: true });
      t.eq(fs.existsSync(tree), false, "tree removed");
      fs.rmSync(tree, { recursive: true, force: true });
      t.ok(errorOf(() => fs.readdirSync(tree)) !== undefined, "listing a missing dir throws");
    },
  },
  {
    name: "F6 createReadStream yields the file bytes",
    async run({ fs, path, dir }, t) {
      const p = path.join(dir, "r.txt");
      fs.writeFileSync(p, "0123456789");
      const parts: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) => {
        const s = fs.createReadStream(p, { start: 2, end: 5 });
        s.on("data", (c: unknown) => parts.push(c as Uint8Array));
        s.on("end", () => resolve());
        s.on("error", reject);
      });
      t.eq(parts.map(text).join(""), "2345", "ranged read");
    },
  },
  {
    name: "F7 path helpers",
    async run({ path }, t) {
      t.eq(path.join("a", "b", "c.txt"), `a${path.sep}b${path.sep}c.txt`, "join");
      t.eq(path.basename(path.join("a", "c.txt")), "c.txt", "basename");
      t.eq(path.extname("photo.jpeg"), ".jpeg", "extname");
      t.eq(path.dirname(path.join("a", "b", "c")), path.join("a", "b"), "dirname");
      t.eq(path.resolve(path.join("a", "b"), ".."), path.resolve("a"), "resolve");
    },
  },
  {
    name: "F8 createWriteStream applies backpressure through pumpStream",
    async run({ fs, path, dir }, t) {
      const p = path.join(dir, "big.bin");
      const { source, pauses } = chunkSource(8, 1024 * 1024);
      const written = await pumpStream(source, {
        createWriter: () => fs.createWriteStream(p) as never,
      });
      t.eq(written, 8 * 1024 * 1024, "bytes reported");
      t.eq(fs.statSync(p).size, 8 * 1024 * 1024, "bytes on disk");
      t.ok(pauses() > 0, "the writer pushed back and the source was paused");
    },
  },
  {
    name: "F9 pumpStream over the writer enforces maxBytes",
    async run({ fs, path, dir }, t) {
      const p = path.join(dir, "capped.bin");
      const { source } = chunkSource(8, 1024);
      const e = await pumpStream(source, {
        createWriter: () => fs.createWriteStream(p) as never,
        maxBytes: 4 * 1024,
      }).then(
        () => undefined,
        (x: unknown) => x,
      );
      t.ok(e instanceof Error && e.message.includes("too large"), "oversize rejected");
    },
  },
];
