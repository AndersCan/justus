import type { Plugin } from "vite";

const variablesId = /design\.css\?variables$/;
const commentPattern = /\/\*[\s\S]*?\*\//g;
const rulePattern = /([^{}]*)\{([^{}]*)\}/g;

/** The stylesheet's top-level blocks (`a { … }`, `@media … { … }`); statements outside a block are dropped. */
function topLevelBlocks(css: string): string[] {
  const text = css.replace(commentPattern, "");
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    switch (text.charAt(index)) {
      case "{":
        depth++;
        break;
      case ";":
        if (depth === 0) start = index + 1;
        break;
      case "}":
        depth--;
        if (depth === 0) {
          blocks.push(text.slice(start, index + 1).trim());
          start = index + 1;
        }
        break;
      default:
        break;
    }
  }
  return blocks;
}

function isRootSelector(selector: string): boolean {
  const trimmed = selector.trim();
  return trimmed.startsWith(":root") || trimmed.startsWith("[data-theme");
}

function isVariableDeclaration(declaration: string): boolean {
  const property = declaration.split(":")[0].trim();
  return property.startsWith("--") || property === "color-scheme";
}

function isVariableRule(rule: RegExpExecArray): boolean {
  const selectors = rule[1].split(",");
  const declarations = rule[2].split(";").filter((declaration) => declaration.trim() !== "");
  return selectors.every(isRootSelector) && declarations.every(isVariableDeclaration);
}

function holdsOnlyVariables(block: string): boolean {
  const rules = [...block.replace(/^@[^{]*\{/, "").matchAll(rulePattern)];
  return rules.length > 0 && rules.every(isVariableRule);
}

/** Keeps the blocks that only set custom properties and `color-scheme` on `:root` or `[data-theme]`. */
export function designVariables(css: string): string {
  const kept = topLevelBlocks(css).filter(holdsOnlyVariables);
  const joined = kept.join("\n");
  return `${joined}\n`;
}

/** Serves `<design.css>?variables` as only its theme variables, so a page keeps its own reset and classes. */
export function siteDesignVariables(): Plugin {
  return {
    name: "justus-design-variables",
    enforce: "pre",
    transform: {
      filter: { id: variablesId },
      handler(code) {
        return { code: designVariables(code), map: undefined };
      },
    },
  };
}
