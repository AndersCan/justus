import type { SharedBatch } from "@justus/core";
import { gateway } from "../gateway";

/** Photos other apps shared to Justus wait in the inbox. Lists them at start and on every
 * `justus:shared` nudge from the host. A nudge during a list runs one more list after it. */
export function listenForSharedPhotos(onBatch: (batch: SharedBatch) => void): void {
  let running = false;
  let again = false;

  async function list(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const [error, result] = await gateway.sharedIn.list();
        if (error || !result) {
          console.warn("justus:share-in.list-failed", error?.message ?? "unknown");
          continue;
        }
        for (const batch of result.batches) onBatch(batch);
      } while (again);
    } finally {
      running = false;
    }
  }

  window.addEventListener("justus:shared", () => void list());
  void list();
}
