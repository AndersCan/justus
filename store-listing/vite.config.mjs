import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default {
  root,
  logLevel: "warn",
  optimizeDeps: { entries: ["store-listing/*.html"] },
  server: { host: "127.0.0.1", port: 5190, strictPort: false },
};
