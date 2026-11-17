import { CoreError, err, ok } from "@ekrooh/bare/core";
import { emptySeen, SEEN_VERSION, type SeenRecord } from "@justus/core";
import { readJsonFile, writeJsonFile } from "./json-file";
import type { Files, Paths } from "./ports/files";

type SeenStoreOpts = { dir: string; files: Files; paths: Paths };

export const SEEN_NEWER_VERSION = "justus.seen/unsupported-version";

export type SeenStore = {
  read(): [null, SeenRecord] | [CoreError, null];
  write(record: SeenRecord): Promise<[null, Record<string, never>] | [CoreError, null]>;
};

/** The seen file in `dir`: the `SeenRecord` itself. Read once on first use,
 * then served from memory; a bad file reads as empty. Writes go to a temp file
 * and are renamed over the real one. A file from a newer app is never
 * overwritten. */
export function createSeenStore(opts: SeenStoreOpts): SeenStore {
  const { files, paths } = opts;
  const file = paths.join(opts.dir, "seen.json");
  let cache: { record: SeenRecord; newer?: number } | null = null;

  function load() {
    if (cache) return cache;
    const parsed = readJsonFile(files, file, "seen.json");
    cache = { record: emptySeen() };
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return cache;
    if (parsed.version !== SEEN_VERSION) {
      if (typeof parsed.version === "number") cache.newer = parsed.version;
      return cache;
    }
    const known = "known" in parsed ? parsed.known : undefined;
    if (typeof known === "object" && known !== null && !Array.isArray(known)) {
      cache.record = parsed as SeenRecord;
    }
    return cache;
  }

  function newerError(version: number) {
    return err(
      SEEN_NEWER_VERSION,
      `seen.json version ${version} is newer than this app: update Justus`,
    );
  }

  return {
    read() {
      const loaded = load();
      if (loaded.newer !== undefined) return newerError(loaded.newer);
      return ok(loaded.record);
    },
    async write(record) {
      const loaded = load();
      if (loaded.newer !== undefined) return newerError(loaded.newer);
      writeJsonFile(files, opts.dir, file, record);
      cache = { record };
      return ok({});
    },
  };
}
