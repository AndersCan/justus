import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import en from "./en.json";
import { parse, scanSource, walk, type Ast } from "./scan";

const SRC = join(import.meta.dirname, "..");

function sources(): string[] {
  const dirs = ["views", "machines", "utils"];
  const files = dirs.flatMap((d) =>
    (readdirSync(join(SRC, d), { recursive: true }) as string[]).map((f) => join(d, f)),
  );
  return [...files, "main.ts"].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
}

/** Text that is not for people: internal error codes, CSS, SVG, date-name tables. */
const NOT_COPY = [
  /^no /,
  / returned no /,
  /^unknown error$/,
  /^friends: could not load$/,
  /^canvas unavailable$/,
  /^gridMotion/,
  /^Internal error/,
  /^(January|February|March|April|May|June|July|August|September|October|November|December)$/,
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/,
  /^hsl\(/,
  /^translate\(/,
  /^\(prefers/,
  /^input, textarea/,
  /^wa-dropdown/,
  /^h-full/,
  /^animate-/,
  /^hidden group/,
  /^<|^\n\s+@keyframes/,
  /^Files$/,
];

type Use = { file: string; id: string; keys: string[] | null };

function usesIn(file: string, src: string): { uses: Use[]; dynamic: string[] } {
  const uses: Use[] = [];
  const dynamic: string[] = [];
  walk(parse(file, src), null, (n: Ast) => {
    if (n.type !== "CallExpression" || n.callee.type !== "Identifier") return;
    if (n.callee.name !== "copy" && n.callee.name !== "t") return;
    const [id, params] = n.arguments as Ast[];
    if (!id || id.type !== "Literal" || typeof id.value !== "string") {
      dynamic.push(file);
      return;
    }
    const keys =
      params === undefined
        ? []
        : params.type === "ObjectExpression"
          ? params.properties.map((p: Ast) => p.key.name ?? p.key.value)
          : null;
    uses.push({ file, id: id.value, keys });
  });
  return { uses, dynamic };
}

const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)(?:\?[^:}]*:[^}]*)?\}/g)].map((m) => m[1]))].sort();

const files = sources().map((f) => ({ file: f, src: readFileSync(join(SRC, f), "utf8") }));
const all = files.map((f) => usesIn(f.file, f.src));
const uses = all.flatMap((a) => a.uses);

describe("copy catalogue", () => {
  it("has a complete entry for every id", () => {
    const bad = Object.entries(en).filter(
      ([, e]) =>
        !e.text ||
        !e.where ||
        !e.who ||
        (e.status !== "draft" && e.status !== "approved") ||
        typeof e.screen !== "string",
    );
    expect(bad.map(([id]) => id)).toEqual([]);
  });

  it("names every id as a string literal", () => {
    expect(all.flatMap((a) => a.dynamic)).toEqual([]);
  });

  it("only uses ids that exist", () => {
    const missing = uses.filter((u) => !(u.id in en)).map((u) => `${u.file}: ${u.id}`);
    expect(missing).toEqual([]);
  });

  it("uses every id", () => {
    const used = new Set(uses.map((u) => u.id));
    expect(Object.keys(en).filter((id) => !used.has(id) && !id.startsWith("store."))).toEqual([]);
  });

  it("keeps the store listing files and their store.* entries in step", () => {
    const dir = join(SRC, "../../android/fastlane/metadata/android/en-US");
    const files = {
      "store.title": "title.txt",
      "store.short_description": "short_description.txt",
      "store.full_description": "full_description.txt",
    };
    const text = (id: string) => (en as Record<string, { text: string }>)[id]?.text;
    const differs = Object.entries(files).filter(
      ([id, file]) => text(id) !== readFileSync(join(dir, file), "utf8").replace(/\r?\n$/, ""),
    );
    expect(differs.map(([id]) => id)).toEqual([]);
    expect(Object.keys(en).filter((id) => id.startsWith("store.") && !(id in files))).toEqual([]);
  });

  it("passes exactly the params each text asks for", () => {
    const wrong = uses
      .filter((u) => u.id in en)
      .filter((u) => {
        const want = placeholders((en as Record<string, { text: string }>)[u.id].text);
        return (
          u.keys === null || JSON.stringify([...new Set(u.keys)].sort()) !== JSON.stringify(want)
        );
      })
      .map((u) => `${u.file}: ${u.id}`);
    expect(wrong).toEqual([]);
  });

  it("leaves no English sentence in views, machines, utils or main", () => {
    const found = files.flatMap(({ file, src }) =>
      scanSource(file, src)
        .filter((f) => !NOT_COPY.some((r) => r.test(f.text)))
        .map(
          (f) =>
            `${relative(SRC, join(SRC, file))}:${src.slice(0, f.start).split("\n").length} ${f.text}`,
        ),
    );
    expect(found).toEqual([]);
  });
});
