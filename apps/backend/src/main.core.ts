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
import { createDevInbox } from "./dev-inbox";
import { registerUploadRoute } from "./upload-route";

const config = resolveJustusConfig();

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

const storageDir = config.storage ?? ".justus-storage";
const cacheDir = config.cache ?? ".justus-cache";

const store: PhotoStore = createPhotoStore({
  storageDir,
  cacheDir,
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

// The real upload route on the worklet's own loopback server — the add path
// the browser "Pick photo" uses in dev and on the device WebView alike.
registerUploadRoute({
  server: runtime.server,
  store,
  uploadsDir: path.join(cacheDir, "uploads"),
});

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
