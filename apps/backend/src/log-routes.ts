import type { LoopbackServer, LoopbackRouteHandler } from "@ekrooh/bare/runtime";
import { classifyOrigin } from "./cors";
import type { LogCollector, LogLevel, LogQuery } from "./log-collector";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * Registers the debug-log HTTP surface (`/__logs`) on the worklet's loopback
 * server (issue #13):
 *   GET  /__logs?format=jsonl|text&tail=N&level=  -> captured entries
 *   POST /__logs                                   -> ingest a batch (loopback origin)
 *
 * Both verbs are gated by the same loopback-origin policy as the rest of the
 * surface (issue #69): a cross-origin page in the WebView must not be able to
 * read the device's debug logs (folder names, peer keys, sync activity) or
 * inject entries. "Loopback is local" is NOT sufficient — the WebView can load
 * other origins, so an unauthenticated same-loopback GET would be exfiltratable
 * exactly like the pre-#69 `POST /photos` was.
 */
export function registerLogRoutes(deps: { server: LoopbackServer; collector: LogCollector }): void {
  deps.server.registerRoute("GET", "/__logs", makeGetHandler(deps.collector));
  deps.server.registerRoute("POST", "/__logs", makePostHandler(deps.collector));
}

function parseQuery(url: string | undefined): LogQuery {
  const q = new URL(url ?? "/", "http://localhost").searchParams;
  const format = q.get("format") === "text" ? "text" : "jsonl";
  const tailRaw = q.get("tail");
  const tail = tailRaw !== null ? Number(tailRaw) : undefined;
  const levelRaw = q.get("level");
  const level = LOG_LEVELS_INCLUDES(levelRaw) ? (levelRaw as LogLevel) : undefined;
  return {
    format,
    tail: Number.isFinite(tail) ? tail : undefined,
    level,
  };
}

function LOG_LEVELS_INCLUDES(v: string | null): v is LogLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error";
}

/** Raised when the request body exceeds the accepted byte budget. Distinct
 * from a generic 500 so the handler can respond 413 and stop consuming bytes. */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Accumulates the request body into a UTF-8 string without pulling in the
 * bare runtime (mirrors `@ekrooh/bare/runtime`'s `collectRequestBody`, which
 * imports bare-fs/-path/-http1 at the top and cannot load under Node/vitest).
 *
 * Unlike the bare equivalent, this enforces `maxBytes` *while* streaming: it
 * stops reading the moment the byte budget is exceeded and destroys the
 * request, so a hostile client cannot exhaust memory by streaming an enormous
 * body before the collector's own size check runs (issue #155, memory-exhaustion
 * DoS). The bound is the collector's `maxBatchBytes`, so the route and the
 * ingest guard agree.
 */
function readBody(
  req: {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    destroy?: () => void;
  },
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy?.();
      } catch {
        // ignore — stream teardown is best-effort
      }
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buf =
        typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
      bytes += buf.length;
      if (bytes > maxBytes) {
        fail(new BodyTooLargeError());
        return;
      }
      body += typeof chunk === "string" ? chunk : decoder.decode(buf, { stream: true });
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body + decoder.decode(new Uint8Array(0)));
    });
    req.on("error", (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

function makeGetHandler(collector: LogCollector): LoopbackRouteHandler {
  return (req, res) => {
    const origin = req.headers?.origin;
    const originStr = typeof origin === "string" ? origin : undefined;
    const verdict = classifyOrigin(originStr);
    if (!verdict.allowed) {
      res.writeHead(403, BASE_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "cross-origin request forbidden" }));
      return;
    }
    const { contentType, body } = collector.query(parseQuery(req.url));
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      ...(verdict.corsOrigin ? { "Access-Control-Allow-Origin": verdict.corsOrigin } : {}),
    });
    res.end(body);
  };
}

function makePostHandler(collector: LogCollector): LoopbackRouteHandler {
  return (req, res) => {
    void (async () => {
      const origin = req.headers?.origin;
      const originStr = typeof origin === "string" ? origin : undefined;
      const verdict = classifyOrigin(originStr);
      if (!verdict.allowed) {
        res.writeHead(403, BASE_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "cross-origin request forbidden" }));
        return;
      }
      try {
        const raw = await readBody(req as never, collector.maxBatchBytes);
        if (!raw) {
          res.writeHead(400, BASE_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "empty body" }));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          res.writeHead(400, BASE_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "invalid json" }));
          return;
        }
        const result = collector.ingestBatch(parsed);
        const status = result.error && result.accepted === 0 ? 400 : 200;
        res.writeHead(status, BASE_HEADERS);
        res.end(JSON.stringify({ ok: !result.error || result.accepted > 0, ...result }));
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          res.writeHead(413, BASE_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "request body too large" }));
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        res.writeHead(500, BASE_HEADERS);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    })();
  };
}
