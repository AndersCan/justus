/**
 * The join flow (join, request, accept) over the drive and network ports.
 * photo-store keeps the session state and calls these in order.
 */
import type { Drive, DriveStore, OpenResult } from "../ports/drive-store";
import type { PeerNetwork } from "../ports/peer-network";
import { parseFolderName, parseRegistry, type RegistryFile } from "./records";

export const DRIVE_PATH_MEMBERS = "/members.json";
export const DRIVE_PATH_FOLDER = "/folder.json";
export const DRIVE_PATH_REQUESTS = "/requests.json";
/** Cap on a small JSON record read off a drive. Any member, or any peer on an album
 * topic for `/requests.json`, controls these bytes; without a cap one file can
 * exhaust memory. 1 MiB holds thousands of members. */
export const MAX_PEER_JSON_BYTES = 1024 * 1024;

export type JoinLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

export type JoinPorts = {
  drives: DriveStore;
  network: PeerNetwork;
  log: JoinLog;
  /** Max ms to wait for a remote drive to be ready. */
  openTimeoutMs: number;
};

export type JoinError =
  | { kind: "cannot-open"; message: string }
  | { kind: "already-enrolled"; message: string }
  | { kind: "write-failed"; message: string };

/** The repo's error tuple (ADR 0002 decision 8, same shape as OpenResult). */
export type JoinResult<T> = [JoinError, null] | [null, T];

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Reads a small text record, or null when missing, unreadable, or larger
 * than {@link MAX_PEER_JSON_BYTES}. */
export async function readRecord(
  drive: Drive,
  options: { path: string; log: JoinLog; timeoutMs?: number },
): Promise<string | null> {
  const { path, log, timeoutMs } = options;
  try {
    const text = await drive.readSmall(
      path,
      MAX_PEER_JSON_BYTES,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
    return text ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", drive: short(drive.key), path, err: errText(thrown) });
    return null;
  }
}

export async function readRegistry(drive: Drive, options: { log: JoinLog }): Promise<RegistryFile> {
  return parseRegistry(await readRecord(drive, { path: DRIVE_PATH_MEMBERS, log: options.log }));
}

/** Opens a drive by key, joining its swarm topic first so peers serve its
 * blocks (a remote `drive.ready()` otherwise waits forever). */
export async function openWithTopic(
  ports: JoinPorts,
  options: { key: string; server: boolean },
): Promise<OpenResult<Drive>> {
  const { drives, network, log, openTimeoutMs } = ports;
  const { key, server } = options;
  const topic = drives.discoveryKeyOf(key);
  const startedAt = Date.now();
  log("drive.open.start", { drive: short(key), topic: short(topic) });
  network.join(topic, { server });
  const [openErr, drive] = await drives.open(key, { timeoutMs: openTimeoutMs });
  if (openErr) {
    log("drive.open.timeout", {
      drive: short(key),
      ms: Date.now() - startedAt,
      err: errText(openErr),
      conns: network.connectionCount(),
    });
    return [openErr, null];
  }
  log("drive.open.ready", {
    drive: short(key),
    ms: Date.now() - startedAt,
    peers: drive.stats().peers,
  });
  network.findPeers(topic, () => drive.stats().peers > 0, {
    drive: drive.key,
    peers: () => drive.stats().peers,
  });
  return [null, drive];
}

/** Opens the album to join: its share drive, the registry and the folder name. */
export async function openAlbum(
  ports: JoinPorts,
  options: { shareKey: string },
): Promise<JoinResult<{ folderDrive: Drive; registry: RegistryFile; folderName: string }>> {
  const [openErr, folderDrive] = await openWithTopic(ports, {
    key: options.shareKey,
    server: false,
  });
  if (openErr) return [{ kind: "cannot-open", message: errText(openErr) }, null];
  const registry = await readRegistry(folderDrive, { log: ports.log });
  const folderName = parseFolderName(
    await readRecord(folderDrive, { path: DRIVE_PATH_FOLDER, log: ports.log }),
  );
  return [null, { folderDrive, registry, folderName }];
}
