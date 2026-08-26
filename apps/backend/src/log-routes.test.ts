import { describe, expect, test } from "vite-plus/test";
import { Readable } from "node:stream";
import { registerLogRoutes } from "./log-routes";
import { createLogCollector } from "./log-collector";
import type { LoopbackRouteHandler } from "@ekrooh/bare/runtime";

type FakeServer = {
  routes: Record<string, LoopbackRouteHandler>;
  registerRoute(m: string, p: string, h: LoopbackRouteHandler): void;
};

function fakeServer(): FakeServer {
  const routes: Record<string, LoopbackRouteHandler> = {};
  return {
    routes,
    registerRoute(m, p, h) {
      routes[`${m} ${p}`] = h;
    },
  };
}

function getReq(url = "/__logs", origin?: string) {
  const req: Record<string, unknown> = { url, headers: origin ? { origin } : {} };
  return req as never;
}

function postReq(body: string | null, origin?: string) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  (r as unknown as { url: string; headers: Record<string, string> }).url = "/__logs";
  (r as unknown as { headers: Record<string, string> }).headers = origin ? { origin } : {};
  return r as never;
}

function mockRes() {
  return {
    status: 0,
    headers: undefined as unknown,
    body: "",
    writeHead(s: number, h: unknown) {
      this.status = s;
      this.headers = h;
      return this;
    },
    end(b: string) {
      this.body = b;
      return this;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("log-routes", () => {
  test("GET /__logs returns captured entries as jsonl by default", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    collector.append({ source: "backend", message: "boot" });
    registerLogRoutes({ server: server as never, collector });

    const res = mockRes();
    server.routes["GET /__logs"](getReq(), res as never);
    expect(res.status).toBe(200);
    expect((res.headers as { "Content-Type": string })["Content-Type"]).toBe(
      "application/x-ndjson",
    );
    expect(JSON.parse(res.body.split("\n")[0]).message).toBe("boot");
  });

  test("GET /__logs supports format=text and tail/level query", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    collector.append({ level: "info", source: "backend", message: "a" });
    collector.append({ level: "error", source: "backend", message: "b" });
    registerLogRoutes({ server: server as never, collector });

    const res = mockRes();
    server.routes["GET /__logs"](getReq("/__logs?format=text&tail=1"), res as never);
    expect((res.headers as { "Content-Type": string })["Content-Type"]).toContain("text/plain");
    expect(res.body).toBe("1970-01-01T00:00:01.000Z ERROR (backend) b");
  });

  test("POST /__logs ingests a batch and echoes accepted/dropped", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    registerLogRoutes({ server: server as never, collector });

    const res = mockRes();
    server.routes["POST /__logs"](
      postReq(JSON.stringify([{ source: "web", message: "hi" }])),
      res as never,
    );
    await tick();
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.accepted).toBe(1);
    expect(collector.entries()[0].message).toBe("hi");
  });

  test("POST /__logs rejects empty and malformed bodies", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    registerLogRoutes({ server: server as never, collector });

    const empty = mockRes();
    server.routes["POST /__logs"](postReq(""), empty as never);
    await tick();
    expect(empty.status).toBe(400);

    const bad = mockRes();
    server.routes["POST /__logs"](postReq("{not json"), bad as never);
    await tick();
    expect(bad.status).toBe(400);
  });

  test("POST /__logs rejects a cross-origin caller", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    registerLogRoutes({ server: server as never, collector });

    const res = mockRes();
    server.routes["POST /__logs"](
      postReq(JSON.stringify([{ message: "x" }]), "https://evil.example"),
      res as never,
    );
    await tick();
    expect(res.status).toBe(403);
    expect(collector.entries()).toHaveLength(0);
  });

  test("GET /__logs rejects a cross-origin caller (no log leak)", () => {
    const server = fakeServer();
    const collector = createLogCollector({ now: () => 1000 });
    collector.append({ source: "backend", message: "secret-device-log" });
    registerLogRoutes({ server: server as never, collector });

    const res = mockRes();
    server.routes["GET /__logs"](getReq("/__logs", "https://evil.example"), res as never);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("secret-device-log");
  });

  test("POST /__logs rejects an oversized body (413) without ingesting (issue #155)", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ maxBatchBytes: 100, now: () => 1000 });
    registerLogRoutes({ server: server as never, collector });

    // A body whose UTF-8 byte length exceeds the 100-byte budget.
    const big = JSON.stringify([{ message: "x".repeat(200) }]);
    const res = mockRes();
    server.routes["POST /__logs"](postReq(big), res as never);
    await tick();
    expect(res.status).toBe(413);
    // The oversized body must never reach ingestBatch: no memory retained and
    // nothing stored. This is the memory-exhaustion DoS fix — the stream is
    // stopped the moment the byte budget is exceeded.
    expect(collector.entries()).toHaveLength(0);
  });

  test("POST /__logs still ingests a body within the budget", async () => {
    const server = fakeServer();
    const collector = createLogCollector({ maxBatchBytes: 100, now: () => 1000 });
    registerLogRoutes({ server: server as never, collector });

    const ok = JSON.stringify([{ source: "web", message: "fits" }]);
    const res = mockRes();
    server.routes["POST /__logs"](postReq(ok), res as never);
    await tick();
    expect(res.status).toBe(200);
    expect(collector.entries()[0].message).toBe("fits");
  });
});
