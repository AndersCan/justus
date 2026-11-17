import type { Files } from "./ports/files";

/** The parsed JSON in `file`; undefined when it is missing, unreadable or not JSON (logged as `name`). */
export function readJsonFile(files: Files, file: string, name: string): unknown {
  let text: string;
  try {
    if (!files.existsSync(file)) return undefined;
    text = files.readFileSync(file, "utf8") as string;
  } catch (e) {
    console.error(`[justus] ${name} unreadable: ${String(e)}`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[justus] ${name} is not JSON: ${String(e)}`);
    return undefined;
  }
}

/** Writes `body` to a temp file and renames it over `file`, so a crash keeps the old file. Throws on failure. */
export function writeJsonFile(files: Files, dir: string, file: string, body: unknown): void {
  const tmp = `${file}.tmp`;
  files.mkdirSync(dir, { recursive: true });
  files.writeFileSync(tmp, JSON.stringify(body));
  files.renameSync(tmp, file);
}
