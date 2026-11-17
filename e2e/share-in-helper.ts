import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

type SharedFile = { path: string; name: string };

/**
 * Writes a shared-photos batch into a worklet's inbox the way a host does: into a
 * dot-prefixed temp dir, `batch.json` last, then a rename. No copies, like an iPhone
 * extension batch before the app collects it. Dispatch `justus:shared` afterwards.
 */
export function writeSharedBatch(cacheDir: string, files: SharedFile[]): { id: string } {
  const id = randomUUID();
  const root = join(cacheDir, "shared-in");
  const tmp = join(root, `.tmp-${id}`);
  mkdirSync(tmp, { recursive: true });
  const items = files.map((f, i) => {
    const file = `${i}${extname(f.path).toLowerCase()}`;
    copyFileSync(f.path, join(tmp, file));
    return { file, name: f.name };
  });
  const manifest = { version: 1, id, receivedAt: new Date().toISOString(), items };
  writeFileSync(join(tmp, "batch.json"), JSON.stringify(manifest));
  renameSync(tmp, join(root, id));
  return { id };
}
