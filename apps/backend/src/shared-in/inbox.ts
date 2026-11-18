import { err, ErrorCode, ok, type CoreError } from "@ekrooh/bare/core";
import {
  MAX_PICK,
  SHARED_IN_EXTS,
  SHARED_IN_MANIFEST,
  SHARED_IN_VERSION,
  TAKEN_AT_RE,
  type SharedBatch,
  type SharedPhoto,
} from "@justus/core";
import { guessMime } from "../mime";
import type { Files, Paths } from "../ports/files";

type Deps = {
  /** `<cacheDir>/shared-in`. */
  dir: string;
  files: Files;
  paths: Paths;
};

/** A batch as the web sees it, plus the absolute original of each photo (parallel to `batch.photos`) for serving bytes. */
export type SharedInListing = { batch: SharedBatch; originals: string[] };

const ID_RE = /^[a-z0-9-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_NAME = 255;

/** A display name with path separators and control characters removed; undefined when nothing is left. */
export function cleanSharedName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[/\\\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME);
  return cleaned === "" ? undefined : cleaned;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function skip(id: string, reason: string) {
  console.error(`[justus] shared-in.skip id=${id} reason=${reason}`);
}

/**
 * The batches waiting in the shared-photos inbox, oldest first. Hosts write a
 * batch into a dot-prefixed temp dir and rename it into place, so dot names are
 * unfinished and skipped. The sharing app is untrusted: every name that reaches
 * a path is matched against a strict pattern and checked with `lstat`.
 * A missing inbox is empty; the only error is an unreadable inbox dir.
 */
export function listSharedIn({
  dir,
  files,
  paths,
}: Deps): [CoreError, null] | [null, SharedInListing[]] {
  let entries: string[];
  try {
    entries = files.readdirSync(dir) as string[];
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return ok([]);
    return err(ErrorCode.HOST_ERROR, `Cannot read the shared photos: ${String(e)}`);
  }

  const listings: SharedInListing[] = [];
  for (const entry of entries.filter((n) => !n.startsWith(".")).sort()) {
    const logId = ID_RE.test(entry) ? entry : "invalid";
    const batchDir = paths.join(dir, entry);
    const manifest = readManifest(files, paths.join(batchDir, SHARED_IN_MANIFEST));
    if (
      !manifest ||
      manifest.id !== entry ||
      !ID_RE.test(entry) ||
      typeof manifest.receivedAt !== "string"
    ) {
      skip(logId, "bad-manifest");
      continue;
    }
    const { id, receivedAt } = manifest;
    const photos: SharedPhoto[] = [];
    const originals: string[] = [];
    manifest.items.slice(0, MAX_PICK).forEach((item, index) => {
      const read = readItem({ files, paths, batchDir, id, item, index });
      if (typeof read === "string") return skip(id, read);
      photos.push(read.photo);
      originals.push(read.original);
    });
    if (photos.length > 0) listings.push({ batch: { id, receivedAt, photos }, originals });
  }

  listings.sort(
    (a, b) =>
      a.batch.receivedAt.localeCompare(b.batch.receivedAt) || a.batch.id.localeCompare(b.batch.id),
  );
  return ok(listings);
}

/** Removes the named batches from the inbox. An id that is not a batch dir there is skipped. */
export function removeSharedIn(
  { dir, files, paths }: Deps,
  ids: unknown,
): [CoreError, null] | [null, number] {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return err(ErrorCode.PLUGIN_ERROR, "ids must be a list of batch ids");
  }
  let removed = 0;
  for (const id of ids as string[]) {
    if (!ID_RE.test(id)) {
      skip("invalid", "bad-id");
      continue;
    }
    const path = paths.join(dir, id);
    try {
      files.lstatSync(path);
      files.rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") continue;
      return err(ErrorCode.HOST_ERROR, `Cannot remove the shared photos: ${String(e)}`);
    }
  }
  console.error(`[justus] shared-in.removed batches=${removed}`);
  return ok(removed);
}

/** The manifest when it is a version-1 object with an items array; undefined for anything else, newer versions included (update Justus). */
function readManifest(files: Files, file: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(files.readFileSync(file, "utf8") as string);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.version !== SHARED_IN_VERSION || !Array.isArray(parsed.items)) {
    return undefined;
  }
  return parsed as { id: unknown; receivedAt: unknown; items: unknown[] };
}

/** A regular file (not a symlink) at `file`. */
function isRegular(files: Files, file: string) {
  try {
    return files.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** The path of the copy named by `key` in `batchDir`: "none" when the key is absent, "bad" when it names no regular file there. */
function copyPath(opts: { files: Files; paths: Paths; batchDir: string }, key: unknown) {
  if (key === undefined) return "none";
  if (typeof key !== "string" || !FILE_RE.test(key)) return "bad";
  const full = opts.paths.join(opts.batchDir, key);
  return isRegular(opts.files, full) ? full : "bad";
}

/** One manifest item as a photo, or the reason it is dropped. */
function readItem(opts: {
  files: Files;
  paths: Paths;
  batchDir: string;
  id: string;
  item: unknown;
  index: number;
}): { photo: SharedPhoto; original: string } | "item" | "type" {
  const { files, paths, batchDir, id, item, index } = opts;
  if (!isObject(item) || typeof item.file !== "string" || !FILE_RE.test(item.file)) return "item";
  const ext = item.file.includes(".")
    ? item.file.slice(item.file.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (!(SHARED_IN_EXTS as readonly string[]).includes(ext)) return "type";
  const original = paths.join(batchDir, item.file);
  if (!isRegular(files, original)) return "item";

  const display = copyPath(opts, item.display);
  const thumb = copyPath(opts, item.thumb);
  // A bad copy drops both copies; the original is still shared as it is.
  const copies = display !== "none" && display !== "bad" && thumb !== "bad";

  const photo: SharedPhoto = {
    path: copies ? display : original,
    name: cleanSharedName(item.name) ?? item.file,
    type: guessMime(`.${ext}`),
    url: `/shared-in/${id}/${index}`,
    ...(copies ? { original } : {}),
    ...(copies && thumb !== "none" ? { thumb } : {}),
    ...(typeof item.takenAt === "string" && TAKEN_AT_RE.test(item.takenAt)
      ? { takenAt: item.takenAt }
      : {}),
  };
  return { photo, original };
}
