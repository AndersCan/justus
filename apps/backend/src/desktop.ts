/**
 * Desktop host contract. The desktop host spawns the packed backend as a
 * sidecar `bare` with labeled tokens plus `handoff=<fd>`, and keeps the
 * child's stdin open for its whole life:
 *
 * - the origin and one-time bootstrap nonce go to the host as one JSON line on
 *   the inherited `handoff` fd (nothing is written to disk);
 * - when the host exits or crashes the OS closes stdin and we shut down rather
 *   than orphan a process holding the loopback port and the storage dir.
 */

/** The `handoff=<fd>` token's fd, or undefined when not launched by a host. */
export function parseHandoffFd(argv: readonly string[]): number | undefined {
  const token = argv.find((a) => a.startsWith("handoff="));
  if (!token) return undefined;
  const fd = Number(token.slice("handoff=".length));
  return Number.isInteger(fd) && fd >= 3 ? fd : undefined;
}

type PipeLike = {
  on(event: string, cb: (...args: never[]) => void): unknown;
  end(data: string): unknown;
};
type PipeCtor = new (fd: number) => PipeLike;

// bare-pipe is a native addon: load it lazily so this module stays importable
// under Node/vitest.
async function loadPipe(): Promise<PipeCtor> {
  const mod = (await import("bare-pipe")) as unknown as { default: PipeCtor };
  return mod.default;
}

/** Calls `onGone` when the host closes our stdin (it exited or crashed). */
export async function watchParentDeath(onGone: () => void): Promise<void> {
  try {
    const Pipe = await loadPipe();
    const stdin = new Pipe(0);
    stdin.on("data", () => {});
    stdin.on("end", onGone);
    stdin.on("error", onGone);
  } catch (err) {
    // Not a pipe (e.g. run by hand from a terminal): nothing to watch.
    console.warn(
      `[desktop] stdin is not a pipe; parent-death detection off: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Writes the one-line handoff to the host and closes the fd. */
export async function sendHandoff(
  fd: number,
  credentials: { origin: string; bootstrap: string },
  onError: (err: Error) => void,
): Promise<void> {
  const Pipe = await loadPipe();
  const out = new Pipe(fd);
  out.on("error", onError);
  out.end(JSON.stringify({ origin: credentials.origin, bootstrap: credentials.bootstrap }) + "\n");
}
