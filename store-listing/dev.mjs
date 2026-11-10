// Mock store page: Play and App Store listings side by side, reloaded on save.
// Usage: pnpm store:listing
import { createServer } from "vite";
import config from "./vite.config.mjs";

const server = await createServer(config);
await server.listen();
console.log(`store:listing: ${server.resolvedUrls?.local[0]}store-listing/`);
