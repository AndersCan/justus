type CoreLike = {
  on(event: "append" | "truncate", cb: () => void): unknown;
  removeListener(event: "append" | "truncate", cb: () => void): unknown;
};

/**
 * Calls `cb` whenever a drive's index changes, from a local write or from
 * replication. Hyperdrive itself emits no `"update"` event: its index core
 * emits `"append"` (and `"truncate"` when a writer forks). Returns an
 * unsubscribe.
 */
export function onDriveChange(drive: { core: CoreLike }, cb: () => void): () => void {
  const core = drive.core;
  core.on("append", cb);
  core.on("truncate", cb);
  return () => {
    core.removeListener("append", cb);
    core.removeListener("truncate", cb);
  };
}
