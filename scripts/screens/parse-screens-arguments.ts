import { left, right } from "./either.ts";
import type { Either } from "./either.ts";
import { parseArgs } from "node:util";
import type { ThemeChoice } from "./screen-file-name.ts";

export type ScreensArguments =
  | { command: "help" }
  | { command: "shoot"; out: string | undefined; themeChoice: ThemeChoice };

export const screensUsage =
  "usage: pnpm screens [--out <folder>] [--theme light|dark|both]\n" +
  "  --out    folder for the PNGs, relative to the repo root (default test-results/screens)\n" +
  "  --theme  light (default), dark, or both for a light and a dark twin of each screen";

/** Reads `--out <folder>`, `--theme light|dark|both` and `--help`. Anything else is an error. */
export function parseScreensArguments(argv: string[]): Either<string, ScreensArguments> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      theme: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });
  if (values.help === true) return right({ command: "help" });
  const unknown = Object.keys(values).find((key) => key !== "out" && key !== "theme");
  if (unknown !== undefined) return left(`unknown option --${unknown}`);
  const extra = positionals.join(" ");
  if (extra !== "") return left(`unexpected argument ${extra}`);
  if (typeof values.out === "boolean") return left("--out needs a folder");
  if (values.out === "") return left("--out needs a folder");
  if (typeof values.theme === "boolean") return left("--theme needs light, dark or both");
  const theme = values.theme ?? "light";
  const themeChoice = themeChoiceFrom(theme);
  if (themeChoice === undefined) return left(`--theme is light, dark or both, not ${theme}`);
  return right({ command: "shoot", out: values.out, themeChoice });
}

function themeChoiceFrom(value: string): ThemeChoice | undefined {
  switch (value) {
    case "light":
    case "dark":
    case "both":
      return value;
    default:
      return undefined;
  }
}
