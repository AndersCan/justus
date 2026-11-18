/**
 * Handing an album to a new Admin (#824). The old Admin leaves `/admin.json` on
 * the drive that holds the lists; every phone follows it hop by hop and trusts
 * a hop only when the album's own lists and the next drive's identity agree.
 * Ports and records only.
 */
import type { Drive, IdentityProof, OpenResult } from "../ports/drive-store";
import {
  MAX_ADMIN_CHAIN,
  isEnrolled,
  parseAdminNote,
  parseRegistry,
  verifiedDeviceIdentity,
  type AdminNote,
} from "../membership/records";
import { DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES } from "../membership/join.ts";
import { errText } from "../p2p-log.ts";
import type { AlbumResult } from "./albums";

export const DRIVE_PATH_ADMIN = "/admin.json";

/** The six list files a new Admin's drive takes over, in digest order. `/members.json` is last on purpose. */
const LIST_PATHS = [
  "/viewers.json",
  "/folder.json",
  "/removed.json",
  "/earlier.json",
  "/former.json",
  DRIVE_PATH_MEMBERS,
] as const;

const READ_MS = 5_000;

async function readLists(drive: Drive): Promise<Array<string | undefined>> {
  const texts: Array<string | undefined> = [];
  for (const path of LIST_PATHS) {
    texts.push(await drive.readSmall(path, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS }));
  }
  return texts;
}

function digestOf(texts: ReadonlyArray<string | undefined>, hash: (text: string) => string) {
  return hash(texts.map((t) => `${(t ?? "").length}:${t ?? ""}`).join("\n"));
}

/** sha-256 (by `hash`) of the six list files' texts as read, a missing file as "". */
export async function listsDigest(drive: Drive, hash: (text: string) => string): Promise<string> {
  return digestOf(await readLists(drive), hash);
}

/** Copies the six list files from the Admin's drive onto the next Admin's own drive, leaving `self` out of the members (an Admin is never in their own list). Writes `/members.json` last. Returns the digest of what was written, the same {@link listsDigest} gives for the next Admin's drive. */
export async function takeAdminRecords(
  from: Drive,
  to: Drive,
  options: { self: string; hash: (text: string) => string },
): Promise<AlbumResult<{ digest: string }>> {
  try {
    const texts = await readLists(from);
    for (let i = 0; i < LIST_PATHS.length - 1; i++) {
      const text = texts[i];
      if (text !== undefined) await to.put(LIST_PATHS[i], Buffer.from(text));
    }
    const registry = parseRegistry(texts[LIST_PATHS.length - 1] ?? null);
    const members = Object.fromEntries(
      Object.entries(registry.members).filter(([, m]) => m.key !== options.self),
    );
    const membersText = JSON.stringify({ version: 1, members });
    await to.put(DRIVE_PATH_MEMBERS, Buffer.from(membersText));
    const written = [...texts.slice(0, LIST_PATHS.length - 1), membersText];
    return [null, { digest: digestOf(written, options.hash) }];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

export type FollowPorts = {
  open: (key: string) => Promise<OpenResult<Drive>>;
  /** Called for a drive `open` gave that is not taken as a hop. */
  release: (drive: Drive) => Promise<void>;
  verify: (proof: IdentityProof) => boolean;
  log: (event: string, fields: Record<string, unknown>) => void;
};

/** Follows `/admin.json` from `from`. A hop is taken only when the next key is a Collaborator in the current lists, its `/device.json` verifies to the named identity, its `/members.json` reads, it is not in `chain` or already followed, and `chain` and the hops together stay under {@link MAX_ADMIN_CHAIN}. Stops at the first hop that fails; the caller tries again on the next change. `unsupported` is true when it stopped at a note of a newer version. The caller releases the hop drives. */
export async function followAdmin(
  ports: FollowPorts,
  options: { from: Drive; chain: readonly string[] },
): Promise<{ hops: Array<{ drive: Drive; next: AdminNote["next"] }>; unsupported: boolean }> {
  const hops: Array<{ drive: Drive; next: AdminNote["next"] }> = [];
  const seen = new Set(options.chain);
  let unsupported = false;
  let current = options.from;
  seen.add(current.key);
  while (options.chain.length + hops.length < MAX_ADMIN_CHAIN) {
    const note = parseAdminNote(
      await current.readSmall(DRIVE_PATH_ADMIN, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS }),
      () => {
        unsupported = true;
      },
    );
    if (!note || seen.has(note.next.key)) break;
    const listed = parseRegistry(
      (await current.readSmall(DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS })) ??
        null,
    );
    if (!isEnrolled(listed, note.next.key)) break;
    const [error, drive] = await ports.open(note.next.key);
    if (error) {
      ports.log("warn", { where: "followAdmin.open", err: error.message });
      break;
    }
    const device = verifiedDeviceIdentity(
      (await drive.readSmall("/device.json", MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS })) ?? "",
      { driveKey: drive.key, verify: ports.verify },
    );
    const members = await drive.readSmall(DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES, {
      timeoutMs: READ_MS,
    });
    if (
      device.status !== "verified" ||
      device.identityKey !== note.next.identity ||
      members === undefined
    ) {
      await ports.release(drive);
      break;
    }
    hops.push({ drive, next: note.next });
    seen.add(drive.key);
    current = drive;
  }
  return { hops, unsupported };
}
