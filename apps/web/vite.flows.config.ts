import { mergeConfig } from "vite-plus";
import base from "./vite.config.ts";

// The live bundle is a library build, which leaves `process.env.NODE_ENV` in
// dependencies such as nanostores; the browser has no `process`.
export default mergeConfig(base, {
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
