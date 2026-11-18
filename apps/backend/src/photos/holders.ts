/**
 * The record each phone keeps of the photos it has a full copy of, and the
 * rules that turn those records into "who has it". Ports only: no photo-store.
 */
import type { PhotoHolders, PhotoMember, QuietHolder } from "@justus/core";
import type { Drive } from "../ports/drive-store";
import { isHexKey } from "../membership/records";
import type { GalleryLog } from "./gallery";
import { errText } from "../p2p-log.ts";

export const HOLDING_PATH = "/holding.json";
export const HELD_DIR = "/held";
export const PREVIEWED_DIR = "/previewed";
/** Photos a phone added and then deleted: one entry per id, in its own album drive. Read only with a holding record (`/holding.json` version 1). */
export const DELETED_DIR = "/deleted-photos";
/** Peer-controlled list bound. */
export const MAX_HELD = 20_000;
const MAX_MARKER_BYTES = 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HELD_BODY = new Uint8Array([0x31]);

export type HeldReport =
  | {
      kind: "reports";
      ids: ReadonlySet<string>;
      previews: ReadonlySet<string>;
      /** The previews list failed: `previews` is empty only because it is unknown. */
      previewsUnknown?: true;
    }
  | { kind: "silent" };
export type HoldersError = { kind: "write-failed"; message: string };
export type HoldersResult<T> = [HoldersError, null] | [null, T];

/** The path of a photo's entry, or undefined for an id that is not safe to use. */
export function heldPath(id: string): string | undefined {
  return SAFE_ID.test(id) ? `${HELD_DIR}/${id}` : undefined;
}

export async function ensureHoldingMarker(drive: Drive): Promise<HoldersResult<boolean>> {
  try {
    if ((await drive.readSmall(HOLDING_PATH, MAX_MARKER_BYTES)) !== undefined) return [null, false];
    await drive.put(HOLDING_PATH, Buffer.from(JSON.stringify({ version: 1 })));
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** Records that this phone has the photo. False when the id is not safe to write. */
export async function markHeld(drive: Drive, id: string): Promise<HoldersResult<boolean>> {
  const path = heldPath(id);
  if (path === undefined) return [null, false];
  try {
    await drive.put(path, HELD_BODY);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** Records that this phone showed the photo's preview. False when the id is not safe to write. */
export async function markPreviewed(drive: Drive, id: string): Promise<HoldersResult<boolean>> {
  if (!SAFE_ID.test(id)) return [null, false];
  try {
    await drive.put(`${PREVIEWED_DIR}/${id}`, HELD_BODY);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** Records that this phone deleted its own photo. False when the id is not safe to write. */
export async function markDeleted(drive: Drive, id: string): Promise<HoldersResult<boolean>> {
  if (!SAFE_ID.test(id)) return [null, false];
  try {
    await drive.put(`${DELETED_DIR}/${id}`, HELD_BODY);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** The ids a phone says it deleted, at most MAX_HELD; undefined when the list is slow or failing (never "deleted nothing"). */
export async function readDeleted(
  drive: Drive,
  opts: { timeoutMs: number; log: GalleryLog },
): Promise<ReadonlySet<string> | undefined> {
  try {
    const listed = await listIds(drive, DELETED_DIR, Date.now() + opts.timeoutMs);
    if ("timedOut" in listed) {
      opts.log("holding.read", { drive: drive.key.slice(0, 8), err: "deleted-timeout" });
      return undefined;
    }
    return listed.ids;
  } catch (thrown: unknown) {
    opts.log("holding.read", { drive: drive.key.slice(0, 8), err: errText(thrown) });
    return undefined;
  }
}

/** The Admin's delete list plus each phone's own deletes as "<driveKey>:<id>". Admin entries pass unchanged. */
export function withOwnDeletes(
  removed: Readonly<Record<string, unknown>>,
  own: ReadonlyMap<string, ReadonlySet<string>>,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...removed };
  for (const [key, ids] of own) {
    for (const id of ids) merged[`${key}:${id}`] ??= true;
  }
  return merged;
}

/** Takes the photo out of this phone's record, full copy and preview. False when the id is not safe to use. */
export async function unmarkHeld(drive: Drive, id: string): Promise<HoldersResult<boolean>> {
  if (!SAFE_ID.test(id)) return [null, false];
  try {
    await drive.del(`${HELD_DIR}/${id}`);
    await drive.del(`${PREVIEWED_DIR}/${id}`);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

function parseVersion(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "number" ? version : undefined;
  } catch {
    return undefined;
  }
}

async function listIds(
  drive: Drive,
  dir: string,
  deadline: number,
): Promise<{ ids: Set<string> } | { timedOut: true }> {
  const ids = new Set<string>();
  const iterator = drive.list(dir)[Symbol.asyncIterator]();
  let seen = 0;
  try {
    while (seen < MAX_HELD) {
      const left = deadline - Date.now();
      if (left <= 0) return { timedOut: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), left);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next === "timeout") return { timedOut: true };
      if (next.done) break;
      seen++;
      const id = next.value.path.slice(dir.length + 1);
      if (SAFE_ID.test(id)) ids.add(id);
    }
  } finally {
    void iterator.return?.();
  }
  return { ids };
}

/** The previews a phone showed, or undefined when the list is slow or failing: it never makes the phone silent. */
async function readPreviews(
  drive: Drive,
  deadline: number,
  log: GalleryLog,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const listed = await listIds(drive, PREVIEWED_DIR, deadline);
    if ("timedOut" in listed) {
      log("holding.read", { drive: drive.key.slice(0, 8), err: "previews-timeout" });
      return undefined;
    }
    return listed.ids;
  } catch (thrown: unknown) {
    log("holding.read", { drive: drive.key.slice(0, 8), err: errText(thrown) });
    return undefined;
  }
}

/** What a phone says it holds. A missing, unreadable or slow record is silent, never "holds nothing". */
export async function readHeld(
  drive: Drive,
  opts: { timeoutMs: number; log: GalleryLog },
): Promise<HeldReport> {
  const { timeoutMs, log } = opts;
  const deadline = Date.now() + timeoutMs;
  try {
    const marker = await drive.readSmall(HOLDING_PATH, MAX_MARKER_BYTES, { timeoutMs });
    if (marker === undefined) return { kind: "silent" };
    const version = parseVersion(marker);
    if (version !== 1) {
      if (version !== undefined) log("holding.unsupported", { version });
      return { kind: "silent" };
    }
    const listed = await listIds(drive, HELD_DIR, deadline);
    if ("timedOut" in listed) {
      log("holding.read", { drive: drive.key.slice(0, 8), err: "timeout" });
      return { kind: "silent" };
    }
    const previews = await readPreviews(drive, deadline, log);
    if (previews === undefined) {
      return { kind: "reports", ids: listed.ids, previews: new Set(), previewsUnknown: true };
    }
    return { kind: "reports", ids: listed.ids, previews };
  } catch (thrown: unknown) {
    log("holding.read", { drive: drive.key.slice(0, 8), err: errText(thrown) });
    return { kind: "silent" };
  }
}

/** Copies the marker and entries to another drive, skipping what is there. Returns how many entries it wrote. */
export async function copyHeld(from: Drive, to: Drive): Promise<number> {
  const marker = await from.readSmall(HOLDING_PATH, MAX_MARKER_BYTES);
  if (marker === undefined) return 0;
  if ((await to.readSmall(HOLDING_PATH, MAX_MARKER_BYTES)) === undefined) {
    await to.put(HOLDING_PATH, Buffer.from(marker));
  }
  let copied = 0;
  for (const dir of [HELD_DIR, PREVIEWED_DIR]) {
    const have = new Set<string>();
    for await (const entry of to.list(dir)) have.add(entry.path);
    let seen = 0;
    for await (const entry of from.list(dir)) {
      if (++seen > MAX_HELD) break;
      if (have.has(entry.path) || !SAFE_ID.test(entry.path.slice(dir.length + 1))) continue;
      await to.put(entry.path, HELD_BODY);
      copied++;
    }
  }
  return copied;
}

function byNameThenKey(a: PhotoMember, b: PhotoMember): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Photos the person's phone says it holds or previewed that the Admin's delete list names on one of `live`'s drives, sorted. `[]` for a silent or missing record. */
export function stillToDrop(input: {
  report: HeldReport | undefined;
  /** Parsed `/removed.json`: "<driveKey>:<id>" -> entry. */
  removed: Readonly<Record<string, unknown>>;
  /** Drives whose deleted photos the phone drops: never a kept (Viewer's) copy or a drive that left. */
  live: ReadonlySet<string>;
}): string[] {
  const { report, removed, live } = input;
  if (report?.kind !== "reports") return [];
  const named = new Set<string>();
  for (const key of Object.keys(removed)) {
    const at = key.indexOf(":");
    if (at > 0 && live.has(key.slice(0, at))) named.add(key.slice(at + 1));
  }
  return [...new Set([...report.ids, ...report.previews])].filter((id) => named.has(id)).sort();
}

function holds(report: HeldReport | undefined, id: string): boolean {
  return report?.kind === "reports" && report.ids.has(id);
}

function previewed(report: HeldReport | undefined, id: string): boolean {
  return report?.kind === "reports" && report.previews.has(id);
}

/** A phone not connected for this long stops counting as having the photo now. */
export const HOLDER_QUIET_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export function holdersFor(input: {
  photo: { id: string; driveKey: string; memberName: string };
  selfKey: string;
  /** By drive key, self included. */
  held: ReadonlyMap<string, HeldReport>;
  /** What this phone can still hear. A removed phone hears nobody, so it has no people to pass. */
  album:
    | {
        kind: "inAlbum";
        /** Current album people; self may be in it. */
        people: ReadonlyArray<PhotoMember>;
        former: ReadonlyArray<{ name: string; ids: ReadonlySet<string>; left?: true }>;
      }
    | { kind: "removed" };
  /** Whether this phone is connected to each person now, and when it last was. */
  presence: (key: string) => { connected: boolean; lastSeenAt?: number };
  /** This phone's clock, for the quiet cut-off. */
  now: number;
}): PhotoHolders {
  const { photo, selfKey, held, album, presence, now } = input;
  const here = photo.driveKey === selfKey || holds(held.get(selfKey), photo.id);
  if (album.kind === "removed") return { kind: "removed", here };
  const { people, former } = album;
  const others = new Map<string, PhotoMember>();
  if (photo.driveKey !== selfKey) {
    others.set(photo.driveKey, { key: photo.driveKey, name: photo.memberName });
  }
  const unsure = new Map<string, PhotoMember>();
  const waiting = new Map<string, PhotoMember>();
  const previews = new Map<string, PhotoMember>();
  for (const person of people) {
    if (person.key === selfKey || person.key === photo.driveKey) continue;
    if (holds(held.get(person.key), photo.id)) others.set(person.key, person);
    else if (held.get(person.key)?.kind !== "reports") unsure.set(person.key, person);
    else if (previewed(held.get(person.key), photo.id)) previews.set(person.key, person);
    else waiting.set(person.key, person);
  }
  const removed = new Set<string>();
  const leavers = new Set<string>();
  for (const entry of former) {
    if (entry.ids.has(photo.id)) (entry.left === true ? leavers : removed).add(entry.name);
  }
  const quiet: QuietHolder[] = [];
  for (const [key, holder] of others) {
    const seen = presence(key);
    if (seen.connected || seen.lastSeenAt === undefined) continue;
    if (now - seen.lastSeenAt < HOLDER_QUIET_AFTER_MS) continue;
    others.delete(key);
    quiet.push({ ...holder, lastSeenAt: seen.lastSeenAt });
  }
  quiet.sort((a, b) => b.lastSeenAt - a.lastSeenAt || byNameThenKey(a, b));
  return {
    kind: "inAlbum",
    here,
    previewHere: !here && previewed(held.get(selfKey), photo.id),
    others: [...others.values()].sort(byNameThenKey),
    quiet,
    unsure: [...unsure.values()].sort(byNameThenKey),
    waiting: [...waiting.values()].sort(byNameThenKey),
    previews: [...previews.values()].sort(byNameThenKey),
    former: [...removed].sort(),
    left: [...leavers].sort(),
  };
}

/** A removed phone tells the Admin it deleted its copy for at most this long. */
export const COPY_DELETED_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
export const FORMER_PATH = "/former.json";
const MAX_FORMER_BYTES = 1024 * 1024;
export const MAX_FORMER_PEOPLE = 50;
export const MAX_FORMER_IDS = 5_000;

/** A person no longer in the album and the photos they had a copy of when they went. */
export type FormerPerson = {
  name: string;
  identity?: string;
  ids: ReadonlySet<string>;
  left?: true;
  /** Discovery key of the album key this person held when removed. Set only by Remove. */
  album?: string;
};

/** The Admin's list of people who left or were removed. Junk, a newer version or a slow read gives an empty list. */
export async function readFormer(drive: Drive, log: GalleryLog): Promise<FormerPerson[]> {
  return (await loadFormer(drive, log)) ?? [];
}

/** Like `readFormer`, but undefined when the list could not be read, so a writer never overwrites what it could not see. A missing file is an empty list. */
async function loadFormer(drive: Drive, log: GalleryLog): Promise<FormerPerson[] | undefined> {
  try {
    const text = await drive.readSmall(FORMER_PATH, MAX_FORMER_BYTES, { timeoutMs: 1_500 });
    if (text === undefined) return [];
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { version, former } = parsed as { version?: unknown; former?: unknown };
    if (version !== 1) {
      log("holding.unsupported", { version: typeof version === "number" ? version : -1 });
      return undefined;
    }
    if (!Array.isArray(former)) return undefined;
    const people: FormerPerson[] = [];
    for (const raw of former.slice(0, MAX_FORMER_PEOPLE)) {
      if (typeof raw !== "object" || raw === null) continue;
      const { name, identity, ids, left, album } = raw as {
        name?: unknown;
        identity?: unknown;
        ids?: unknown;
        left?: unknown;
        album?: unknown;
      };
      if (typeof name !== "string" || name === "" || !Array.isArray(ids)) continue;
      const safe = new Set<string>();
      for (const id of ids.slice(0, MAX_FORMER_IDS)) {
        if (typeof id === "string" && SAFE_ID.test(id)) safe.add(id);
      }
      people.push({
        name,
        ...(typeof identity === "string" ? { identity } : {}),
        ids: safe,
        ...(left === true ? { left } : {}),
        ...(typeof album === "string" && isHexKey(album) ? { album } : {}),
      });
    }
    return people;
  } catch (thrown: unknown) {
    log("holding.read", { drive: drive.key.slice(0, 8), err: errText(thrown) });
    return undefined;
  }
}

async function writeFormer(drive: Drive, people: ReadonlyArray<FormerPerson>): Promise<void> {
  const former = people.slice(-MAX_FORMER_PEOPLE).map((p) => ({
    name: p.name,
    ...(p.identity !== undefined ? { identity: p.identity } : {}),
    ids: [...p.ids].slice(-MAX_FORMER_IDS),
    ...(p.left === true ? { left: true } : {}),
    ...(p.album !== undefined ? { album: p.album } : {}),
  }));
  await drive.put(FORMER_PATH, Buffer.from(JSON.stringify({ version: 1, former })));
}

/** Notes a person who is going, with what they had. Newest last; the oldest entries go first. The same identity is merged. */
export async function addFormer(
  drive: Drive,
  person: FormerPerson,
  log: GalleryLog,
): Promise<HoldersResult<boolean>> {
  if (person.ids.size === 0) return [null, false];
  try {
    const rest = await loadFormer(drive, log);
    if (rest === undefined) {
      return [{ kind: "write-failed", message: "Cannot read the former list" }, null];
    }
    const same =
      person.identity === undefined ? undefined : rest.find((p) => p.identity === person.identity);
    const merged: FormerPerson = same
      ? { ...person, ids: new Set([...same.ids, ...person.ids]) }
      : person;
    await writeFormer(drive, [...rest.filter((p) => p !== same), merged]);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** The person is back in the album: their entry goes. False when there was none. */
export async function dropFormer(
  drive: Drive,
  identity: string,
  log: GalleryLog,
): Promise<HoldersResult<boolean>> {
  try {
    const rest = await loadFormer(drive, log);
    if (rest === undefined) {
      return [{ kind: "write-failed", message: "Cannot read the former list" }, null];
    }
    const left = rest.filter((p) => p.identity !== identity);
    if (left.length === rest.length) return [null, false];
    await writeFormer(drive, left);
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/**
 * A removed person's phone says it deleted its copy of the album with this discovery key.
 * Marks their entry as left. Matches by identity and `album` only, never by name.
 * `current` are the identities still in the album: someone back in it is never marked.
 */
export async function markFormerLeft(
  drive: Drive,
  input: { identity: string; album: string; current: ReadonlySet<string> },
  log: GalleryLog,
): Promise<HoldersResult<"marked" | "no-entry" | "already-left" | "in-album">> {
  try {
    const all = await loadFormer(drive, log);
    if (all === undefined) {
      return [{ kind: "write-failed", message: "Cannot read the former list" }, null];
    }
    if (input.current.has(input.identity)) return [null, "in-album"];
    const entry = all.find((p) => p.identity === input.identity && p.album === input.album);
    if (entry === undefined) return [null, "no-entry"];
    if (entry.left === true) return [null, "already-left"];
    await writeFormer(
      drive,
      all.map((p) => (p === entry ? { ...p, left: true as const } : p)),
    );
    return [null, "marked"];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** Copies the list to another drive when the album moves. */
export async function copyFormer(from: Drive, to: Drive): Promise<void> {
  const text = await from.readSmall(FORMER_PATH, MAX_FORMER_BYTES);
  if (text !== undefined) await to.put(FORMER_PATH, Buffer.from(text));
}
