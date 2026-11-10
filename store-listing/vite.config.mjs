import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readMock } from "./listing.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const WATCHED = [
  "store-listing/images.json",
  "store-listing/captures",
  "apps/android/fastlane/metadata/android/en-US",
  "apps/ios/fastlane/metadata/en-US",
];

function listingApi() {
  return {
    name: "store-listing-api",
    configureServer(server) {
      server.middlewares.use("/store-listing/api/listing", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(readMock(root)));
      });
      for (const path of WATCHED) server.watcher.add(join(root, path));
      const reload = (file) => {
        const path = relative(root, file);
        if (WATCHED.some((watched) => path === watched || path.startsWith(`${watched}/`))) {
          server.ws.send({ type: "full-reload" });
        }
      };
      for (const event of ["add", "change", "unlink"]) server.watcher.on(event, reload);
    },
  };
}

export default {
  root,
  logLevel: "warn",
  plugins: [listingApi()],
  optimizeDeps: { entries: ["store-listing/*.html"] },
  server: { host: "127.0.0.1", port: 5190, strictPort: false },
};
