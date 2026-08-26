import { createLoopbackPush, createWorkletRuntime } from "@ekrooh/bare/runtime";
import { photoSpecs, type PhotoChanged } from "@justus/core";
import fs from "bare-fs";
import path from "bare-path";
import crypto from "bare-crypto";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { resolveJustusConfig } from "./config";
import { createPhotoStore, type PhotoStore } from "./photo-store";
import { createPhotosPlugin } from "./photos-plugin";
import { createLogsPlugin } from "./logs-plugin";
import { createDevInbox } from "./dev-inbox";
import { registerUploadRoute } from "./upload-route";
import { createLogCollector } from "./log-collector";
import type { FsLike, PathLike } from "./log-collector";
import { registerLogRoutes } from "./log-routes";

const config = resolveJustusConfig();

const storageDir = config.storage ?? ".justus-storage";
const cacheDir = config.cache ?? ".justus-cache";

// Debug-log collector: capture the backend's own console output from the very
// first line of startup into a bounded ring buffer + rotating JSONL, served
// over /__logs (issue #13). Installed before the runtime/store are built so
// their construction logs are captured too.
const logCollector = createLogCollector({
  dir: cacheDir,
  // The production runtime injects the real bare fs/path (the module avoids a
  // top-level bare import so it loads under Node/vitest — see log-collector).
  fs: fs as unknown as FsLike,
  path: path as unknown as PathLike,
});
logCollector.start();

const runtime = createWorkletRuntime({
  webAssets: config.webAssets,
  storage: config.storage,
  cache: config.cache,
  auth: config.auth,
  port: config.port,
});

// Backend → web push seam (`createLoopbackPush`, shipped in @ekrooh/bare
// 0.2.0): writes DISPATCH envelopes to the connected protocol socket.
const push = createLoopbackPush(runtime.server, runtime.protocol);

function pushChange(change: PhotoChanged) {
  push(
    {
      type: "DISPATCH",
      pluginId: photoSpecs.changed.pluginId,
      event: photoSpecs.changed.name,
      args: change,
    },
    null,
  );
}

const store: PhotoStore = createPhotoStore({
  storageDir,
  cacheDir,
  // The dev inbox (and any picker-configured local import root) writes files
  // OUTSIDE `cacheDir`, so it must be an allowed import root or `addFromPath`
  // rejects it as FORBIDDEN (issue #157, introduced by the #118 root
  // containment). The upload route stages under `cacheDir/uploads`, which is
  // already covered by the default `[cacheDir]` root.
  importRoots: config.inbox ? [cacheDir, config.inbox] : [cacheDir],
  server: runtime.server,
  deviceName: `Device-${Math.floor(Math.random() * 100000)}`,
  onChanged: pushChange,
  seedOnEmpty: config.dev,
  bootstrap: config.bootstrap,
  fs,
  path,
  crypto,
  makeCorestore: (dir) => new Corestore(dir),
  makeDrive: (cs, key) => new Hyperdrive(cs as never, key),
});

runtime.pluginRegistry.register(createPhotosPlugin({ store }));
runtime.pluginRegistry.register(createLogsPlugin({ collector: logCollector }));

// The real upload route on the worklet's own loopback server — the add path
// the browser "Pick photo" uses in dev and on the device WebView alike.
registerUploadRoute({
  server: runtime.server,
  store,
  uploadsDir: path.join(cacheDir, "uploads"),
});

// Debug-log surface: pull backend lifecycle logs and ingest external batches.
registerLogRoutes({ server: runtime.server, collector: logCollector });

if (config.dev && config.inbox) {
  createDevInbox({
    inboxDir: config.inbox,
    onFile: (filePath) => {
      void (async () => {
        const [err] = await store.add(filePath);
        if (err) console.error(`[justus] inbox import failed: ${err.message}`);
      })();
    },
  });
}

void store
  .ready()
  .then(() => runtime.start())
  .then((credentials) => {
    console.log(`[justus] worklet ready at ${credentials.origin}`);
    return store.status();
  })
  .then((status) => {
    console.log(
      `[justus] role=${status.folder.role} name=${status.name} photos=${status.photos} peers=${status.peers}`,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[justus] startup failed: ${message}`);
  });
