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

/** Accumulates the request body into a UTF-8 string without pulling in the
 * bare runtime (mirrors `@ekrooh/bare/runtime`'s `collectRequestBody`, which
 * imports bare-fs/-path/-http1 at the top and cannot load under Node/vitest). */
function readBody(req: {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}): Promise<string> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let body = "";
    req.on("data", (chunk) => {
      body +=
        typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    });
    req.on("end", () => resolve(body + decoder.decode(new Uint8Array(0))));
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
        const raw = await readBody(req as never);
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
        const message = e instanceof Error ? e.message : String(e);
        res.writeHead(500, BASE_HEADERS);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    })();
  };
}
