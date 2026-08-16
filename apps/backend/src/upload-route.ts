import fs from "bare-fs";
import path from "bare-path";
import type { LoopbackRouteHandler, LoopbackServer } from "@ekrooh/bare/runtime";
import { pumpToFile } from "./photo-store";
import type { PhotoStore } from "./photo-store";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const JSON_RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Referrer-Policy": "no-referrer",
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type UploadRouteDeps = {
  server: LoopbackServer;
  store: PhotoStore;
  /** Temp dir for received uploads (e.g. `<cache>/uploads`). */
  uploadsDir: string;
};

/**
 * Registers `POST /photos` on the worklet's own loopback server — a real
 * upload route (auth-gated on device) that writes the request body to a temp
 * file and feeds the photo store directly, exactly like the native picker's
 * path would. The browser "Pick photo" posts same-origin in the WebView, and
 * via the Vite proxy in dev; one add path everywhere. Replaces the dev-only
 * Node upload server + inbox indirection.
 */
export function registerUploadRoute(deps: UploadRouteDeps): void {
  fs.mkdirSync(deps.uploadsDir, { recursive: true });
  deps.server.registerRoute("POST", "/photos", handleUpload(deps));
}

function handleUpload(deps: UploadRouteDeps): LoopbackRouteHandler {
  return (req, res) => {
    void (async () => {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const name = sanitizeName(query.get("filename"));
      // Unique subdir per upload so the persisted file's basename is the
      // original file name (the store uses it as the photo's display name)
      // without two concurrent same-name uploads colliding.
      const uploadDir = path.join(
        deps.uploadsDir,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      fs.mkdirSync(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, name);
      const send = (status: 200 | 400 | 500, body: { ok: boolean; error?: string }) => {
        res.writeHead(status, JSON_RESPONSE_HEADERS);
        res.end(JSON.stringify(body));
      };
      try {
        const bytes = await pumpToFile(req, filePath, MAX_UPLOAD_BYTES);
        if (bytes === 0) {
          send(400, { ok: false, error: "empty upload" });
          return;
        }
        const [err] = await deps.store.add(filePath);
        if (err) {
          send(500, { ok: false, error: err.message });
          return;
        }
        send(200, { ok: true });
      } catch (e) {
        const message = errMsg(e);
        console.error(`[justus] upload failed: ${message}`);
        send(500, { ok: false, error: message });
      } finally {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // temp file already gone
        }
      }
    })();
  };
}

function sanitizeName(name: string | null): string {
  const base =
    String(name ?? "photo")
      .split(/[/\\]/)
      .pop() ?? "photo";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "-");
  return clean || "photo";
}
