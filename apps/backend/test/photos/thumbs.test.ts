import { describe, expect, it } from "vite-plus/test";
import type { holdersFor } from "../../src/photos/holders.ts";

type InAlbumHolders = Extract<ReturnType<typeof holdersFor>, { kind: "inAlbum" }>;
import type { Drive, DownloadResult } from "../../src/ports/drive-store.ts";
import { fetchThumbs, thumbsToFetch, THUMBS_AT_ONCE } from "../../src/photos/thumbs.ts";

const person = (key: string) => ({ key, name: key });
function holders(over: Partial<InAlbumHolders> = {}): InAlbumHolders {
  return {
    kind: "inAlbum",
    here: false,
    previewHere: false,
    others: [],
    quiet: [],
    unsure: [],
    waiting: [],
    previews: [],
    former: [],
    left: [],
    ...over,
  };
}
const photo = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  driveKey: "ada",
  addedAt: 1,
  hasThumb: true as const,
  holders: holders(),
  ...over,
});
const on =
  (...keys: string[]) =>
  (k: string) =>
    keys.includes(k);

describe("thumbsToFetch", () => {
  it("lists newest first, then by id", () => {
    const todo = thumbsToFetch({
      photos: [photo("b", { addedAt: 1 }), photo("c", { addedAt: 5 }), photo("a", { addedAt: 1 })],
      connected: on("ada"),
    });
    expect(todo.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(todo[0]!.path).toBe("/thumbs/c.jpg");
  });

  it("skips photos without a preview, held, previewed, or with no connected source", () => {
    const todo = thumbsToFetch({
      photos: [
        photo("nothumb", { hasThumb: undefined }),
        photo("here", { holders: holders({ here: true }) }),
        photo("prev", { holders: holders({ previewHere: true }) }),
        photo("far", { driveKey: "zed" }),
        photo("ok"),
      ],
      connected: on("ada"),
    });
    expect(todo.map((t) => t.id)).toEqual(["ok"]);
  });

  it("never fetches for removed or unknown holders", () => {
    const todo = thumbsToFetch({
      photos: [
        photo("rm", { holders: { kind: "removed", here: false } }),
        photo("unknown", { holders: undefined }),
      ],
      connected: on("ada"),
    });
    expect(todo).toEqual([]);
  });

  it("counts another phone with the photo or its preview as a source", () => {
    const todo = thumbsToFetch({
      photos: [
        photo("viaFull", { driveKey: "zed", holders: holders({ others: [person("cy")] }) }),
        photo("viaPreview", { driveKey: "zed", holders: holders({ previews: [person("cy")] }) }),
        photo("viaUnsure", { driveKey: "zed", holders: holders({ unsure: [person("cy")] }) }),
      ],
      connected: on("cy"),
    });
    expect(todo.map((t) => t.id).sort()).toEqual(["viaFull", "viaPreview"]);
  });
});

function stubDrive(script: (path: string) => DownloadResult | Promise<DownloadResult>): Drive {
  return { download: async (path: string) => script(path) } as unknown as Drive;
}
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    driveKey: "ada",
    path: `/thumbs/p${i}.jpg`,
  }));
const noLog = () => {};

describe("fetchThumbs", () => {
  it("records each preview that arrived, and skips missing ones", async () => {
    const landed: string[] = [];
    const run = await fetchThumbs({
      todo: items(3),
      driveOf: () => stubDrive((p) => (p.includes("p1") ? "missing" : "here")),
      landed: async (id) => void landed.push(id),
      log: noLog,
    });
    expect(run).toEqual({ fetched: 2 });
    expect(landed.sort()).toEqual(["p0", "p2"]);
  });

  it("never has more than THUMBS_AT_ONCE in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const run = await fetchThumbs({
      todo: items(12),
      driveOf: () =>
        stubDrive(async (): Promise<DownloadResult> => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return "here";
        }),
      landed: async () => {},
      log: noLog,
    });
    expect(run.fetched).toBe(12);
    expect(peak).toBe(THUMBS_AT_ONCE);
  });

  it("starts nothing new after a timeout", async () => {
    const started: string[] = [];
    const run = await fetchThumbs({
      todo: items(20),
      driveOf: () =>
        stubDrive(async (p): Promise<DownloadResult> => {
          started.push(p);
          return "timedOut";
        }),
      landed: async () => {},
      log: noLog,
    });
    expect(run).toEqual({ fetched: 0, stopped: "timedOut" });
    expect(started.length).toBeLessThanOrEqual(THUMBS_AT_ONCE);
  });

  it("stops with an error when a download throws, and logs it", async () => {
    const logged: string[] = [];
    const run = await fetchThumbs({
      todo: items(20),
      driveOf: () =>
        stubDrive(async () => {
          throw new Error("boom");
        }),
      landed: async () => {},
      log: (event: string) => void logged.push(event),
    });
    expect(run.stopped).toBe("error");
    expect(logged).toContain("error");
  });

  it("goes on past a photo whose drive is gone", async () => {
    const landed: string[] = [];
    const run = await fetchThumbs({
      todo: [{ id: "x", driveKey: "gone", path: "/thumbs/x.jpg" }, ...items(1)],
      driveOf: (k) => (k === "gone" ? undefined : stubDrive(() => "here")),
      landed: async (id) => void landed.push(id),
      log: noLog,
    });
    expect(run).toEqual({ fetched: 1 });
    expect(landed).toEqual(["p0"]);
  });

  it("runs four at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await fetchThumbs({
      todo: items(12),
      driveOf: () =>
        stubDrive(async (): Promise<DownloadResult> => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return "here";
        }),
      landed: async () => {},
      log: noLog,
    });
    expect(peak).toBe(4);
  });

  it("goes on past more gone drives than it runs at once", async () => {
    const gone = Array.from({ length: 4 }, (_, i) => ({
      id: `g${i}`,
      driveKey: "gone",
      path: `/thumbs/g${i}.jpg`,
    }));
    const run = await fetchThumbs({
      todo: [...gone, ...items(1)],
      driveOf: (k) => (k === "gone" ? undefined : stubDrive(() => "here")),
      landed: async () => {},
      log: noLog,
    });
    expect(run).toEqual({ fetched: 1 });
  });
});
