import { parseSync } from "oxc-parser";

/**
 * Finds user-facing English in a source file: text nodes and a11y attributes of
 * `html` templates, plus string literals that read like a sentence or a label.
 * The catalogue test fails on any finding; the migration script rewrites them.
 */

// oxc's ESTree nodes are plain objects; only the fields read here are named.
// oxlint-disable-next-line typescript/no-explicit-any
export type Ast = { type: string; start: number; end: number } & Record<string, any>;

export type Param = { name: string; src: string };

export type Finding = {
  kind: "text" | "attr" | "literal";
  start: number;
  end: number;
  /** Text with `{name}` and `{n?one:other}` placeholders. */
  text: string;
  params: Param[];
  /** Enclosing tag for text and attrs; parent node type for literals. */
  tag: string;
  attr?: string;
  /** The AST node of a literal finding. */
  node?: Ast;
};

const ATTRS = new Set([
  "aria-label",
  "title",
  "placeholder",
  "alt",
  "aria-description",
  "aria-placeholder",
  "aria-valuetext",
  "label",
]);
const MARK = "";
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&middot;": "·",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
  "&rarr;": "→",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
};
const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "path",
  "circle",
  "rect",
  "line",
]);
const RENAME: Record<string, string> = {
  formatRelative: "when",
  formatFullDate: "date",
  toLowerCase: "name",
  toLocaleTimeString: "time",
  linkEndText: "end",
  shortPeer: "device",
  length: "count",
  value: "number",
  INTRO_CARD_COUNT: "total",
};

const decode = (s: string) => s.replace(/&[#\w]+;/g, (m) => ENTITIES[m] ?? m);

export function walk(node: Ast, parent: Ast | null, fn: (n: Ast, p: Ast | null) => void): void {
  fn(node, parent);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") walk(c, node, fn);
    } else if (v && typeof v.type === "string") walk(v, node, fn);
  }
}

export const parse = (file: string, src: string): Ast =>
  parseSync(file, src, { lang: "ts" }).program as unknown as Ast;

export const isHtmlTag = (n: Ast) =>
  n.type === "TaggedTemplateExpression" && n.tag.type === "Identifier" && n.tag.name === "html";

function baseName(e: Ast): string {
  if (e.type === "Identifier") return e.name;
  if (e.type === "MemberExpression" && !e.computed && e.property.type === "Identifier")
    return e.property.name;
  if (e.type === "CallExpression") {
    const c = e.callee;
    if (c.type === "Identifier") return c.name;
    if (c.type === "MemberExpression" && c.property.type === "Identifier") return c.property.name;
  }
  return "value";
}
const paramName = (e: Ast) => {
  const n = baseName(e);
  return Object.hasOwn(RENAME, n) ? RENAME[n] : n;
};

const stringOf = (b: Ast): string | null => {
  if (b.type === "Literal" && typeof b.value === "string") return b.value;
  if (b.type === "TemplateLiteral" && b.expressions.length === 0) return b.quasis[0].value.cooked;
  return null;
};

/** `n === 1 ? "photo" : "photos"` as the placeholder `{n?photo:photos}`. */
export function pluralParts(e: Ast): { n: Ast; one: string; other: string } | null {
  if (e.type !== "ConditionalExpression") return null;
  const t = e.test;
  if (t.type !== "BinaryExpression" || (t.operator !== "===" && t.operator !== "==")) return null;
  const n =
    t.right.type === "Literal" && t.right.value === 1
      ? t.left
      : t.left.type === "Literal" && t.left.value === 1
        ? t.right
        : null;
  if (!n) return null;
  const one = stringOf(e.consequent);
  const other = stringOf(e.alternate);
  if (one === null || other === null) return null;
  if (/[:}?]/.test(one) || /[:}?]/.test(other)) return null;
  return { n, one, other };
}

function hasHtml(e: Ast): boolean {
  let found = false;
  walk(e, null, (n) => {
    if (isHtmlTag(n)) found = true;
  });
  return found;
}

/** Whether a `${}` between words is a value for the sentence (not markup or a list). */
function isParam(e: Ast): boolean {
  if (isHtmlTag(e) || e.type === "ArrowFunctionExpression" || e.type === "FunctionExpression")
    return false;
  if (
    e.type === "CallExpression" &&
    e.callee.type === "MemberExpression" &&
    ["map", "flatMap"].includes(e.callee.property.name)
  )
    return false;
  if (pluralParts(e)) return true;
  if (e.type === "ConditionalExpression" || e.type === "LogicalExpression") return !hasHtml(e);
  return true;
}

/** Collects `${}` expressions as named params while text is built. */
function paramSink(src: string) {
  const params: Param[] = [];
  const names = new Set<string>();
  const nameFor = (ex: Ast) => {
    const s = src.slice(ex.start, ex.end);
    const same = params.find((p) => p.src === s);
    if (same) return same.name;
    const base = paramName(ex);
    let nm = base;
    for (let c = 2; names.has(nm); c++) nm = base + c;
    names.add(nm);
    params.push({ name: nm, src: s });
    return nm;
  };
  const textFor = (ex: Ast) => {
    const p = pluralParts(ex);
    if (p) return `{${nameFor(p.n)}?${p.one}:${p.other}}`;
    return `{${nameFor(ex)}}`;
  };
  return { params, textFor };
}

const hasWords = (t: string) => /[A-Za-z]{2}/.test(t.replace(/\{[^}]*\}/g, ""));

/** Text nodes and a11y attributes of one `html` template. */
export function htmlFindings(tl: Ast, src: string): Finding[] {
  let joined = "";
  const offs: number[] = [];
  const mk = new Map<number, number>();
  tl.quasis.forEach((q: Ast, i: number) => {
    const raw: string = q.value.raw;
    for (let j = 0; j < raw.length; j++) {
      joined += raw[j];
      offs.push(q.start + 1 + j);
    }
    if (i < tl.expressions.length) {
      mk.set(joined.length, i);
      joined += MARK;
      offs.push(tl.expressions[i].start - 2);
    }
  });
  const exprAt = (k: number): Ast => tl.expressions[mk.get(k) as number];
  const endOf = (idx: number) => {
    if (!mk.has(idx)) return offs[idx] + 1;
    let e = exprAt(idx).end;
    while (src[e] !== "}") e++;
    return e + 1;
  };
  const items: Finding[] = [];
  const stack: string[] = [];
  const n = joined.length;
  const isWs = (k: number) => /\s/.test(joined[k]) && !mk.has(k);

  const emit = (x0: number, y0: number, tag: string) => {
    let x = x0;
    let y = y0;
    while (x < y && isWs(x)) x++;
    while (y > x && isWs(y - 1)) y--;
    if (x >= y) return;
    const sink = paramSink(src);
    let t = "";
    for (let k = x; k < y; k++) t += mk.has(k) ? sink.textFor(exprAt(k)) : joined[k];
    t = t.replace(/\s+/g, " ");
    if (!hasWords(t) && !/^[A-Z]$/.test(t)) return;
    items.push({
      kind: "text",
      start: offs[x],
      end: endOf(y - 1),
      text: decode(t),
      params: sink.params,
      tag,
    });
  };
  const flush = (a: number, b: number, tag: string) => {
    let from = a;
    for (let k = a; k < b; k++) {
      if (mk.has(k) && !isParam(exprAt(k))) {
        emit(from, k, tag);
        from = k + 1;
      }
    }
    emit(from, b, tag);
  };

  let i = 0;
  let textStart = 0;
  while (i < n) {
    if (joined[i] !== "<") {
      i++;
      continue;
    }
    const top = stack[stack.length - 1] ?? "";
    if (joined.startsWith("<!--", i)) {
      flush(textStart, i, top);
      const e = joined.indexOf("-->", i);
      i = e < 0 ? n : e + 3;
      textStart = i;
      continue;
    }
    if (joined[i + 1] === "/") {
      flush(textStart, i, top);
      stack.pop();
      i = joined.indexOf(">", i) + 1;
      textStart = i;
      continue;
    }
    if (!/[A-Za-z]/.test(joined[i + 1] ?? "")) {
      i++;
      continue;
    }
    flush(textStart, i, top);
    let j = i + 1;
    while (j < n && /[\w:-]/.test(joined[j])) j++;
    const name = joined.slice(i + 1, j);
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(joined[j])) j++;
      if (j >= n) break;
      if (joined[j] === ">") {
        j++;
        break;
      }
      if (joined[j] === "/" && joined[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      const a = j;
      while (j < n && !/[\s=>]/.test(joined[j]) && !(joined[j] === "/" && joined[j + 1] === ">"))
        j++;
      const attr = joined.slice(a, j);
      if (joined[j] !== "=") continue;
      j++;
      const q = joined[j];
      if (q !== '"' && q !== "'") {
        while (j < n && !/[\s>]/.test(joined[j])) j++;
        continue;
      }
      const s = j;
      j++;
      while (j < n && joined[j] !== q) j++;
      j++;
      if (!ATTRS.has(attr)) continue;
      const sink = paramSink(src);
      let t = "";
      for (let k = s + 1; k < j - 1; k++) t += mk.has(k) ? sink.textFor(exprAt(k)) : joined[k];
      if (!hasWords(t)) continue;
      items.push({
        kind: "attr",
        start: offs[s],
        end: offs[j - 1] + 1,
        text: decode(t),
        params: sink.params,
        tag: name,
        attr,
      });
    }
    if (name === "style" || name === "script") {
      const e = joined.indexOf("</" + name, j);
      j = e < 0 ? n : e;
      textStart = j;
      i = j;
      continue;
    }
    if (!selfClose && !VOID.has(name)) stack.push(name);
    i = j;
    textStart = j;
  }
  flush(textStart, n, stack[stack.length - 1] ?? "");
  return items;
}

const CLASSY = /\b(flex|px-|text-|rounded|gap-|items-|w-\d|h-\d|bg-|ui-|grid-cols)/;

/** String and template literals that read like text a person sees. */
export function literalFindings(program: Ast, src: string): Finding[] {
  const out: Finding[] = [];
  walk(program, null, (n, p) => {
    if (!p) return;
    let text: string;
    let params: Param[] = [];
    if (n.type === "Literal" && typeof n.value === "string") text = n.value;
    else if (n.type === "TemplateLiteral" && p.type !== "TaggedTemplateExpression") {
      const sink = paramSink(src);
      text = "";
      n.quasis.forEach((q: Ast, i: number) => {
        text += q.value.cooked;
        if (i < n.expressions.length) text += sink.textFor(n.expressions[i]);
      });
      params = sink.params;
    } else return;
    if (!hasWords(text)) return;
    if (
      p.type === "ImportDeclaration" ||
      p.type === "ExportAllDeclaration" ||
      p.type === "ExportNamedDeclaration" ||
      p.type === "TSLiteralType" ||
      p.type === "TSImportType" ||
      p.type === "SwitchCase" ||
      (p.type === "Property" && p.key === n) ||
      (p.type === "BinaryExpression" && /[=!]=/.test(p.operator))
    )
      return;
    if (!/\s/.test(text) && !/^[A-Z][a-z]+$/.test(text) && !/[.!?…]$/.test(text)) return;
    if (/^[\w.:/@#-]+$/.test(text) && !/^[A-Z][a-z]+$/.test(text)) return;
    if (CLASSY.test(text)) return;
    out.push({
      kind: "literal",
      start: n.start,
      end: n.end,
      text,
      params,
      tag: p.type,
      node: n,
    });
  });
  return out;
}

/** Every finding in a source file, outermost-first by position. */
export function scanSource(file: string, src: string): Finding[] {
  const program = parse(file, src);
  const found: Finding[] = [...literalFindings(program, src)];
  walk(program, null, (n) => {
    if (isHtmlTag(n)) found.push(...htmlFindings(n.quasi, src));
  });
  return found.sort((a, b) => a.start - b.start);
}
