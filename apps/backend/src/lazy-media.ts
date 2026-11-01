import type { LoopbackServer } from "@ekrooh/bare/runtime";
import type { Files } from "./ports/files";

/** Where a served photo's bytes come from: `open` makes sure they are on disk
 * (spooling them off the member's drive on first use) and returns the file. */
export type MediaSource = {
  mime: string;
  open(): Promise<string>;
};

type FileSystem = Pick<Files, "statSync" | "createReadStream">;

export type LazyMedia = {
  /** Serve `route` from `source`. Nothing is fetched until the route is loaded. */
  serve(route: string, source: MediaSource): void;
  /** Stop serving `route`: later loads get a 404. */
  drop(route: string): void;
  has(route: string): boolean;
};

/**
 * Photo routes whose bytes are pulled only when the Web layer loads them.
 *
 * Listing an album used to spool every member's photo to disk and mount the
 * file, so opening an album downloaded all of it. A route here instead spools
 * on its first GET: the grid fetches thumbnails as they scroll into view, and
 * a display copy only when the photo is opened. Hyperdrive replicates sparsely,
 * so blocks nobody reads are never downloaded.
 *
 * The loopback server can't unregister a route, so each one looks its source
 * up per request; `drop` makes it answer 404.
 */
export function createLazyMedia(server: LoopbackServer, fs: FileSystem): LazyMedia {
  const sources = new Map<string, MediaSource>();
  const registered = new Set<string>();

  return {
    serve(route, source) {
      sources.set(route, source);
      if (registered.has(route)) return;
      registered.add(route);
      server.registerRoute("GET", route, (_req, res) => {
        void (async () => {
          const current = sources.get(route);
          if (!current) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
          }
          let file: string;
          let size: number;
          try {
            file = await current.open();
            size = fs.statSync(file).size;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[justus] could not fetch ${route}: ${message}`);
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Photo unavailable");
            return;
          }
          res.writeHead(200, {
            "Content-Type": current.mime,
            "Content-Length": String(size),
            // A photo's route names fixed bytes (a new photo gets a new id).
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          // A client abort destroys the pipe; unhandled, PREMATURE_CLOSE crashes the backend.
          const stream = fs.createReadStream(file) as unknown as {
            on(event: "error", cb: (e: Error) => void): void;
            pipe(dest: unknown): void;
          };
          stream.on("error", (e) => {
            // The client went away (the grid cancels loads as it scrolls): expected.
            if ((e as { code?: string }).code === "PREMATURE_CLOSE") return;
            console.error(`[justus] read of ${route} failed: ${e.message}`);
          });
          stream.pipe(res);
        })();
      });
    },
    drop(route) {
      sources.delete(route);
    },
    has(route) {
      return sources.has(route);
    },
  };
}
