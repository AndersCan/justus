import { left, right } from "./either.ts";
import type { Either } from "./either.ts";
import { parseArgs } from "node:util";
import type { ThemeChoice } from "./screen-file-name.ts";

export interface ScreensArguments {
  out: string | undefined;
  themeChoice: ThemeChoice;
}

export const screensUsage = "usage: pnpm screens [--out <folder>] [--theme light|dark|both]";

/** Reads `--out <folder>` and `--theme light|dark|both` (light when left out). Anything else is an error. */
export function parseScreensArguments(argv: string[]): Either<string, ScreensArguments> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, theme: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const unknown = Object.keys(values).find((key) => key !== "out" && key !== "theme");
  if (unknown !== undefined) return left(`unknown option --${unknown}`);
  const extra = positionals.join(" ");
  if (extra !== "") return left(`unexpected argument ${extra}`);
  if (typeof values.out === "boolean") return left("--out needs a folder");
  if (typeof values.theme === "boolean") return left("--theme needs light, dark or both");
  const themeChoice = themeChoiceFrom(values.theme ?? "light");
  if (themeChoice === undefined) return left("--theme is light, dark or both");
  return right({ out: values.out, themeChoice });
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
