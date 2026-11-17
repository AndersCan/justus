import { CoreError, err, ok } from "@ekrooh/bare/core";
import { emptySeen, parseSeen, SeenError, SEEN_VERSION, type SeenRecord } from "@justus/core";
import type { Files, Paths } from "./ports/files";

type SeenStoreOpts = { dir: string; files: Files; paths: Paths };

export type SeenStore = {
  read(): [null, SeenRecord] | [CoreError, null];
  write(record: SeenRecord): Promise<[null, Record<string, never>] | [CoreError, null]>;
};

type Loaded = { record: SeenRecord; newerVersion?: number };

function readSeen(files: Files, file: string): Loaded {
  let text: string;
  try {
    if (!files.existsSync(file)) return { record: emptySeen() };
    text = files.readFileSync(file, "utf8") as string;
  } catch (e) {
    console.error(`[justus] seen.json unreadable: ${String(e)}`);
    return { record: emptySeen() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`[justus] seen.json unreadable: not JSON: ${String(e)}`);
    return { record: emptySeen() };
  }
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  if (typeof version === "number" && version !== SEEN_VERSION) {
    return { record: emptySeen(), newerVersion: version };
  }
  const record = parseSeen(parsed);
  if (!record) {
    console.error("[justus] seen.json unreadable: unexpected shape");
    return { record: emptySeen() };
  }
  return { record };
}

/** The seen file in `dir`: the `SeenRecord` itself. Read once on first use,
 * then served from memory. Writes go to a temp file and are renamed over the
 * real one, so a crash keeps the old file. A file from a newer app is never
 * overwritten. */
export function createSeenStore(opts: SeenStoreOpts): SeenStore {
  const { files, paths } = opts;
  const file = paths.join(opts.dir, "seen.json");
  let cache: Loaded | null = null;

  function load(): Loaded {
    cache ??= readSeen(files, file);
    return cache;
  }

  function newerError(version: number) {
    return err(
      SeenError.UNSUPPORTED_VERSION,
      `seen.json version ${version} is newer than this app: update Justus`,
    );
  }

  return {
    read() {
      const loaded = load();
      if (loaded.newerVersion !== undefined) return newerError(loaded.newerVersion);
      return ok(loaded.record);
    },
    async write(record) {
      const loaded = load();
      if (loaded.newerVersion !== undefined) return newerError(loaded.newerVersion);
      const next = parseSeen(record);
      if (!next) return err(SeenError.INVALID, "not a seen record");
      const tmp = `${file}.tmp`;
      try {
        files.mkdirSync(opts.dir, { recursive: true });
        files.writeFileSync(tmp, JSON.stringify(next));
        files.renameSync(tmp, file);
      } catch (e) {
        return err(SeenError.WRITE_FAILED, `could not save seen: ${String(e)}`);
      }
      cache = { record: next };
      return ok({});
    },
  };
}
