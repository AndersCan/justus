import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import uno from "../uno.config.ts";
import { isHtmlTag, parse, walk, type Ast } from "./copy/scan";

const SRC = import.meta.dirname;

type Source = { file: string; src: string };
type DesignShortcut = { key: string; classes: string[]; fn: string; source: string };
type Shortcuts = { design: DesignShortcut[]; local: Map<string, string[]> };
type Element = { tag: string; line: number; tokens: string[] };

/** Shortcuts in uno.config.ts that justus draws itself, with what design lacks. */
const APP_SHORTCUTS: Record<string, string> = {
  "ui-card": "app card surface; design has no card",
  "ui-focus": "focus ring for controls design does not draw yet",
  "ui-btn": "base of the coral add button; design has no action button yet",
  "ui-label": "section label text, not a component",
};

/** Hand-drawn controls that stay until design has the component, counted per file. */
const KNOWN_HAND_DRAWN: Record<string, { count: number; what: string }> = {
  "views/album.ts": {
    count: 4,
    what: "icon button, link-style button, photo picker label, coral add button",
  },
  "views/albums.ts": { count: 1, what: "album row button" },
  "views/app-lock.ts": { count: 1, what: "segmented choice" },
  "views/gallery.ts": {
    count: 4,
    what: "filter chip, link-style button, album tile link, add-photos tile",
  },
  "views/lightbox.ts": { count: 4, what: "icon buttons and photo arrows" },
  "views/logs.ts": { count: 1, what: "filter chip" },
  "views/photo-holders.ts": { count: 1, what: "holders row button" },
  "views/settings.ts": { count: 1, what: "settings card link" },
  "views/theme-toggle.ts": { count: 2, what: "segmented choice" },
};

const HINT =
  "A shared component's look lives in AndersCan/design. No design component fits? Add one there and run npm run sync, or list the file in KNOWN_HAND_DRAWN (apps/web/src/design-drift.test.ts) with what design lacks.";

const CONTROLS = new Set(["button", "a", "label", "input", "select", "textarea", "dialog"]);
const BUTTON_HINT = `Use design's button: class="ui-btn-primary" or class="ui-btn-ghost" (buttonClass in #design/components/button.ts).`;
const INPUT_HINT = `Use design's input: class="ui-input" (inputClass in #design/components/input.ts).`;
const SHEET_HINT = `Use design's sheet: class="ui-sheet-dialog" with a class="ui-sheet" panel (sheetClass in #design/components/sheet.ts).`;
const PLACEHOLDER = "\uE000";

function sources(): Source[] {
  const dirs = ["views", "machines", "utils"];
  const files = dirs.flatMap((d) =>
    (readdirSync(join(SRC, d), { recursive: true }) as string[]).map((f) => join(d, f)),
  );
  return [...files, "main.ts"]
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((file) => ({ file, src: readFileSync(join(SRC, file), "utf8") }));
}

function readShortcuts(unoSrc: string, expanded: Record<string, string>): Shortcuts {
  const imports = new Map<string, string>();
  const props: Ast[] = [];
  walk(parse("uno.config.ts", unoSrc), null, (n) => {
    if (n.type === "ImportDeclaration" && String(n.source.value).startsWith("#design/")) {
      for (const s of n.specifiers) imports.set(s.local.name, String(n.source.value));
    }
    if (
      n.type === "Property" &&
      n.key.name === "shortcuts" &&
      n.value.type === "ObjectExpression"
    ) {
      props.push(...n.value.properties);
    }
  });
  const design: DesignShortcut[] = [];
  const local = new Map<string, string[]>();
  for (const p of props) {
    const key = String(p.key.value ?? p.key.name);
    const tokens = (expanded[key] ?? "").split(/\s+/).filter(Boolean);
    let fn = "";
    walk(p.value, null, (n) => {
      if (!fn && n.type === "CallExpression" && imports.has(n.callee.name)) fn = n.callee.name;
    });
    if (fn) design.push({ key, classes: tokens, fn, source: imports.get(fn) ?? "" });
    else local.set(key, tokens);
  }
  return { design, local };
}

function appShortcutProblems(shortcuts: Shortcuts): string[] {
  const unlisted = [...shortcuts.local.keys()]
    .filter((k) => !Object.hasOwn(APP_SHORTCUTS, k))
    .map(
      (k) =>
        `uno.config.ts shortcut ${k} is drawn in justus, not design. Build it in AndersCan/design, sync it, and call its class function here; or add ${k} to APP_SHORTCUTS with what design lacks.`,
    );
  const stale = Object.keys(APP_SHORTCUTS)
    .filter((k) => !shortcuts.local.has(k))
    .map((k) => `APP_SHORTCUTS lists ${k}, which is no longer a local shortcut: remove it.`);
  return [...unlisted, ...stale];
}

function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) {
      parts.push(token.slice(from, i));
      from = i + 1;
    }
  }
  return [...parts, token.slice(from)];
}

// Paint or shape: colour, corners, border, ring, shadow. Focus rings and "none" resets are not a look.
const LOOK = /^(bg|rounded|border|ring|shadow)(-|$)/;
const NOT_LOOK = new Set(["bg-transparent", "border-0", "ring-0", "rounded-none", "shadow-none"]);

function isLook(token: string, shortcuts: Shortcuts, seen = new Set<string>()): boolean {
  const local = shortcuts.local.get(token);
  if (local) {
    if (seen.has(token)) return false;
    seen.add(token);
    return local.some((t) => isLook(t, shortcuts, seen));
  }
  const parts = splitVariants(token);
  if (parts.slice(0, -1).some((p) => p.includes("focus"))) return false;
  const last = parts[parts.length - 1];
  return LOOK.test(last) && !NOT_LOOK.has(last);
}

function constStrings(ast: Ast): Map<string, string> {
  const out = new Map<string, string>();
  walk(ast, null, (n) => {
    if (
      n.type === "VariableDeclarator" &&
      n.id.type === "Identifier" &&
      n.init?.type === "Literal" &&
      typeof n.init.value === "string"
    ) {
      out.set(n.id.name, n.init.value);
    }
  });
  return out;
}

function stringsIn(expr: Ast, consts: Map<string, string>): string[] {
  const out: string[] = [];
  walk(expr, null, (n) => {
    if (n.type === "Literal" && typeof n.value === "string") out.push(n.value);
    if (n.type === "TemplateElement") out.push(n.value.cooked);
    if (n.type === "Identifier" && consts.has(n.name)) out.push(consts.get(n.name) ?? "");
  });
  return out;
}

function elementsIn({ file, src }: Source): Element[] {
  const ast = parse(file, src);
  const consts = constStrings(ast);
  const found: Element[] = [];
  walk(ast, null, (n) => {
    if (!isHtmlTag(n)) return;
    const { quasis, expressions } = n.quasi;
    let text = "";
    const origin: number[] = [];
    quasis.forEach((q: Ast, i: number) => {
      const raw: string = q.value.raw;
      for (let k = 0; k < raw.length; k++) origin.push(q.start + k);
      text += raw;
      if (i < expressions.length) {
        origin.push(q.end);
        text += PLACEHOLDER;
      }
    });
    for (const m of text.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gs)) {
      const attrs = m[2];
      const cls = /\bclass=(?:"([^"]*)"|(\uE000))/.exec(attrs);
      if (!cls) continue;
      const value = cls[1] ?? cls[2];
      const attrStart = m.index + m[0].indexOf(attrs) + cls.index;
      const before = (text.slice(0, attrStart).match(/\uE000/g) ?? []).length;
      const slots = [...value.matchAll(/\uE000/g)].map((_, i) => expressions[before + i]);
      const staticTokens = value.replaceAll(PLACEHOLDER, " ").split(/\s+/);
      const tokens = [
        ...new Set(
          [
            ...staticTokens,
            ...slots.flatMap((e) => stringsIn(e, consts).flatMap((s) => s.split(/\s+/))),
          ].filter(Boolean),
        ),
      ];
      const offset = origin[m.index] ?? 0;
      const line = src.slice(0, offset).split("\n").length;
      found.push({ tag: m[1], line, tokens });
    }
  });
  return found;
}

const handDrawnMessage = (file: string, e: Element, look: string[]) => {
  const hint =
    e.tag === "dialog"
      ? SHEET_HINT
      : e.tag === "input" || e.tag === "select" || e.tag === "textarea"
        ? INPUT_HINT
        : BUTTON_HINT;
  return `${file}:${e.line} <${e.tag}> is drawn by hand (${look.join(" ")}). ${hint}`;
};

function driftIn(
  source: Source,
  shortcuts: Shortcuts,
): { handDrawn: string[]; problems: string[] } {
  const handDrawn: string[] = [];
  const problems: string[] = [];
  const keys = new Set(shortcuts.design.map((s) => s.key));
  for (const e of elementsIn(source)) {
    const looks = e.tokens.filter((t) => isLook(t, shortcuts));
    const pasted = shortcuts.design.find(
      (s) =>
        s.classes.length >= 3 &&
        !e.tokens.includes(s.key) &&
        s.classes.some((c) => isLook(c, shortcuts)) &&
        s.classes.every((c) => e.tokens.includes(c)),
    );
    const usesDesign = e.tokens.some((t) => keys.has(t));
    const extra = looks.filter((t) => !shortcuts.local.has(t));
    if (pasted) {
      problems.push(
        `${source.file}:${e.line} <${e.tag}> copies design's ${pasted.key} classes by hand. Use class="${pasted.key}" (${pasted.fn} in ${pasted.source}).`,
      );
    } else if (usesDesign && extra.length > 0) {
      const used = shortcuts.design.find((s) => e.tokens.includes(s.key));
      problems.push(
        `${source.file}:${e.line} <${e.tag}> repaints design's ${used?.key} with ${extra.join(" ")}. Change the look in design (${used?.fn} in ${used?.source}) or drop ${extra.join(" ")}.`,
      );
    } else if (CONTROLS.has(e.tag) && !usesDesign && looks.length > 0) {
      handDrawn.push(handDrawnMessage(source.file, e, looks));
    }
  }
  return { handDrawn, problems };
}

function knownProblems(
  handDrawn: Map<string, string[]>,
  list: Record<string, { count: number; what: string }>,
): string[] {
  const files = new Set([...handDrawn.keys(), ...Object.keys(list)]);
  return [...files].sort().flatMap((file) => {
    const found = handDrawn.get(file) ?? [];
    const known = list[file];
    const allowed = known?.count ?? 0;
    if (found.length > allowed) {
      return [
        `${file} has ${found.length} hand-drawn controls; KNOWN_HAND_DRAWN allows ${allowed} (${known?.what ?? "nothing"}). The new one is among:`,
        ...found,
      ];
    }
    if (found.length < allowed) {
      const to = found.length === 0 ? "remove its entry" : `lower it to ${found.length}`;
      return [
        `${file} has ${found.length} hand-drawn controls; KNOWN_HAND_DRAWN says ${allowed}: ${to}.`,
      ];
    }
    return [];
  });
}

const SHORTCUTS = readShortcuts(
  readFileSync(join(SRC, "..", "uno.config.ts"), "utf8"),
  (uno.shortcuts ?? {}) as Record<string, string>,
);
const driftOf = (src: string) => driftIn({ file: "views/t.ts", src }, SHORTCUTS);
const toastClasses = SHORTCUTS.design.find((s) => s.key === "ui-toast")?.classes.join(" ") ?? "";

describe("design drift", () => {
  it("a hand-styled button fails and names buttonClass", () => {
    expect(
      driftOf('html`<button class="rounded-full bg-indigo-600 px-4">x</button>`').handDrawn,
    ).toEqual([
      `views/t.ts:1 <button> is drawn by hand (rounded-full bg-indigo-600). ${BUTTON_HINT}`,
    ]);
  });

  it("the line is where the tag starts", () => {
    expect(
      driftOf('const a = 1;\nconst b = html`\n  <a class="rounded-lg">x</a>`').handDrawn,
    ).toEqual([`views/t.ts:3 <a> is drawn by hand (rounded-lg). ${BUTTON_HINT}`]);
  });

  it("a button with design's class passes", () => {
    expect(driftOf('html`<button class="ui-btn-primary w-full">x</button>`')).toEqual({
      handDrawn: [],
      problems: [],
    });
  });

  it("a wrapper button with no paint passes", () => {
    expect(driftOf('html`<button class="flex w-full items-center text-left">x</button>`')).toEqual({
      handDrawn: [],
      problems: [],
    });
  });

  it("a focus ring alone is not a look", () => {
    expect(
      driftOf('html`<button class="focus-visible:ring-2 focus-visible:ring-accent/50">x</button>`'),
    ).toEqual({ handDrawn: [], problems: [] });
  });

  it("a reset to no border or corners is not a look", () => {
    expect(
      driftOf('html`<button class="border-0 rounded-none bg-transparent">x</button>`'),
    ).toEqual({
      handDrawn: [],
      problems: [],
    });
  });

  it("a design shortcut of two classes is not paste-checked", () => {
    const small: Shortcuts = {
      design: [
        {
          key: "ui-pill",
          classes: ["rounded-full", "bg-surface"],
          fn: "pillClass",
          source: "#design/components/pill.ts",
        },
      ],
      local: new Map(),
    };
    expect(
      driftIn(
        { file: "views/t.ts", src: 'html`<div class="rounded-full bg-surface">x</div>`' },
        small,
      ),
    ).toEqual({
      handDrawn: [],
      problems: [],
    });
  });

  it("a hand-styled input names inputClass", () => {
    expect(driftOf('html`<input class="rounded-lg border px-2" />`').handDrawn).toEqual([
      `views/t.ts:1 <input> is drawn by hand (rounded-lg border). ${INPUT_HINT}`,
    ]);
  });

  it("a hand-styled dialog names the sheet", () => {
    expect(driftOf('html`<dialog class="rounded-t-3xl bg-white">x</dialog>`').handDrawn).toEqual([
      `views/t.ts:1 <dialog> is drawn by hand (rounded-t-3xl bg-white). ${SHEET_HINT}`,
    ]);
  });

  it("a class from a same-file const is checked", () => {
    expect(
      driftOf('const c = "rounded-xl bg-accent"; html`<button class=${c}>x</button>`').handDrawn,
    ).toEqual([`views/t.ts:1 <button> is drawn by hand (rounded-xl bg-accent). ${BUTTON_HINT}`]);
  });

  it("both branches of a class ternary are checked", () => {
    expect(driftOf('html`<button class=${on ? "ui-tab-selected" : "ui-tab"}>x</button>`')).toEqual({
      handDrawn: [],
      problems: [],
    });
    expect(
      driftOf('html`<button class=${on ? "ui-btn-primary" : "bg-red-500"}>x</button>`').problems,
    ).toEqual([
      `views/t.ts:1 <button> repaints design's ui-btn-primary with bg-red-500. Change the look in design (buttonClass in #design/components/button.ts) or drop bg-red-500.`,
    ]);
  });

  it("pasting design's toast classes names ui-toast", () => {
    expect(driftOf(`html\`<div class="${toastClasses}">x</div>\``).problems).toEqual([
      `views/t.ts:1 <div> copies design's ui-toast classes by hand. Use class="ui-toast" (toastClass in #design/components/toast.ts).`,
    ]);
  });

  it("repainting a design button fails", () => {
    expect(
      driftOf('html`<button class="ui-btn-primary bg-indigo-600">x</button>`').problems,
    ).toEqual([
      `views/t.ts:1 <button> repaints design's ui-btn-primary with bg-indigo-600. Change the look in design (buttonClass in #design/components/button.ts) or drop bg-indigo-600.`,
    ]);
  });

  it("a local shortcut not built from design fails", () => {
    const shortcuts = readShortcuts(
      'import { buttonClass } from "#design/components/button.ts";\nexport default { shortcuts: { "ui-chip": "rounded-full px-2", "ui-b": buttonClass() } };',
      { "ui-chip": "rounded-full px-2", "ui-b": "rounded-xl" },
    );
    expect(appShortcutProblems(shortcuts).filter((p) => p.includes("ui-chip"))).toEqual([
      "uno.config.ts shortcut ui-chip is drawn in justus, not design. Build it in AndersCan/design, sync it, and call its class function here; or add ui-chip to APP_SHORTCUTS with what design lacks.",
    ]);
  });

  it("known files may keep their count, not more", () => {
    const one = new Map([["views/x.ts", ["a"]]]);
    const two = new Map([["views/x.ts", ["a", "b"]]]);
    const none = new Map<string, string[]>();
    const list = { "views/x.ts": { count: 1, what: "a chip" } };
    expect([knownProblems(one, list), knownProblems(two, list), knownProblems(none, list)]).toEqual(
      [
        [],
        [
          "views/x.ts has 2 hand-drawn controls; KNOWN_HAND_DRAWN allows 1 (a chip). The new one is among:",
          "a",
          "b",
        ],
        ["views/x.ts has 0 hand-drawn controls; KNOWN_HAND_DRAWN says 1: remove its entry."],
      ],
    );
  });

  it("justus has no drift beyond the known list", () => {
    const handDrawn = new Map<string, string[]>();
    const problems = appShortcutProblems(SHORTCUTS);
    for (const source of sources()) {
      const found = driftIn(source, SHORTCUTS);
      problems.push(...found.problems);
      if (found.handDrawn.length > 0) handDrawn.set(source.file, found.handDrawn);
    }
    problems.push(...knownProblems(handDrawn, KNOWN_HAND_DRAWN));
    expect(problems, HINT).toEqual([]);
  });
});
