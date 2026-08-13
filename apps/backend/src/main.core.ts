import { MessageType } from "@ekrooh/bare/core";
import { createWorkletRuntime } from "@ekrooh/bare/runtime";
import type { PhotoChanged } from "@justus/core";
import { resolveJustusConfig } from "./config";
import { createPhotoStore, type PhotoStore } from "./photo-store";
import { createPhotosPlugin } from "./photos-plugin";
import { createDevInbox } from "./dev-inbox";

const config = resolveJustusConfig();

const runtime = createWorkletRuntime({
  webAssets: config.webAssets,
  storage: config.storage,
  cache: config.cache,
  auth: config.auth,
  port: config.port,
});

// Backend → web push seam. The published @ekrooh/bare@0.1.0 has no
// `createLoopbackPush`, so we register our own connection handler on the
// loopback server and write dispatch frames to the single protocol socket.
let pushSocket: { write(data: unknown): boolean } | null = null;
runtime.server.onConnection((socket) => {
  pushSocket = socket;
  socket.on("close", () => {
    if (pushSocket === socket) pushSocket = null;
  });
});

function push(change: PhotoChanged) {
  if (!pushSocket) return;
  try {
    const frame = runtime.protocol.encode(
      MessageType.ENVELOPE,
      {
        type: "DISPATCH",
        pluginId: "justus.photos",
        event: "photos.changed",
        args: change,
      },
      null,
    );
    pushSocket.write(frame);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[justus] push failed: ${message}`);
  }
}

const storageDir = config.storage ?? ".justus-storage";
const cacheDir = config.cache ?? ".justus-cache";

const store: PhotoStore = createPhotoStore({
  storageDir,
  cacheDir,
  server: runtime.server,
  deviceName: `Device-${Math.floor(Math.random() * 100000)}`,
  onChanged: push,
  seedOnEmpty: config.dev,
  bootstrap: config.bootstrap,
});

runtime.pluginRegistry.register(createPhotosPlugin({ store }));

let _inbox: ReturnType<typeof createDevInbox> | null = null;
if (config.dev && config.inbox) {
  _inbox = createDevInbox({
    inboxDir: config.inbox,
    onFile: (filePath) => {
      void store.add(filePath);
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
      `[justus] role=${status.role} name=${status.name} photos=${status.photos} peers=${status.peers}`,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[justus] startup failed: ${message}`);
  });
