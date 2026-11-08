/**
 * The record each phone keeps of the photos it has a full copy of, and the
 * rules that turn those records into "who has it". Ports only: no photo-store.
 */
import type { PhotoHolders, PhotoMember } from "@justus/core";
import type { Drive } from "../ports/drive-store";
import type { GalleryLog } from "./gallery";

export const HOLDING_PATH = "/holding.json";
export const HELD_DIR = "/held";
/** Peer-controlled list bound. */
export const MAX_HELD = 20_000;
const MAX_MARKER_BYTES = 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HELD_BODY = new Uint8Array([0x31]);

export type HeldReport = { kind: "reports"; ids: ReadonlySet<string> } | { kind: "silent" };
export type HoldersError = { kind: "write-failed"; message: string };
export type HoldersResult<T> = [HoldersError, null] | [null, T];

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

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
  deadline: number,
): Promise<{ ids: Set<string> } | { timedOut: true }> {
  const ids = new Set<string>();
  const iterator = drive.list(HELD_DIR)[Symbol.asyncIterator]();
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
      const id = next.value.path.slice(HELD_DIR.length + 1);
      if (SAFE_ID.test(id)) ids.add(id);
    }
  } finally {
    void iterator.return?.();
  }
  return { ids };
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
    const listed = await listIds(drive, deadline);
    if ("timedOut" in listed) {
      log("holding.read", { drive: drive.key.slice(0, 8), err: "timeout" });
      return { kind: "silent" };
    }
    return { kind: "reports", ids: listed.ids };
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
  const have = new Set<string>();
  for await (const entry of to.list(HELD_DIR)) have.add(entry.path);
  let copied = 0;
  let seen = 0;
  for await (const entry of from.list(HELD_DIR)) {
    if (++seen > MAX_HELD) break;
    if (have.has(entry.path) || !SAFE_ID.test(entry.path.slice(HELD_DIR.length + 1))) continue;
    await to.put(entry.path, HELD_BODY);
    copied++;
  }
  return copied;
}

function byNameThenKey(a: PhotoMember, b: PhotoMember): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function holds(report: HeldReport | undefined, id: string): boolean {
  return report?.kind === "reports" && report.ids.has(id);
}

export function holdersFor(input: {
  photo: { id: string; driveKey: string; memberName: string };
  selfKey: string;
  /** Current album people; self may be in it. */
  people: ReadonlyArray<PhotoMember>;
  /** By drive key, self included. */
  held: ReadonlyMap<string, HeldReport>;
  former: ReadonlyArray<{ name: string; ids: ReadonlySet<string> }>;
}): PhotoHolders {
  const { photo, selfKey, people, held, former } = input;
  const here = photo.driveKey === selfKey || holds(held.get(selfKey), photo.id);
  const others = new Map<string, PhotoMember>();
  if (photo.driveKey !== selfKey) {
    others.set(photo.driveKey, { key: photo.driveKey, name: photo.memberName });
  }
  const unsure = new Map<string, PhotoMember>();
  for (const person of people) {
    if (person.key === selfKey || person.key === photo.driveKey) continue;
    if (holds(held.get(person.key), photo.id)) others.set(person.key, person);
    else if (held.get(person.key)?.kind !== "reports") unsure.set(person.key, person);
  }
  const names = new Set<string>();
  for (const entry of former) if (entry.ids.has(photo.id)) names.add(entry.name);
  return {
    here,
    others: [...others.values()].sort(byNameThenKey),
    unsure: [...unsure.values()].sort(byNameThenKey),
    former: [...names].sort(),
  };
}
