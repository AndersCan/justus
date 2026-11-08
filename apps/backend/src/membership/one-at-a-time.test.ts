import { describe, it, expect } from "vite-plus/test";
import { oneAtATime } from "./one-at-a-time";

function deferred() {
  let done = () => {};
  const promise = new Promise<void>((r) => (done = r));
  return { promise, done };
}

describe("oneAtATime", () => {
  it("starts the second run for a key only after the first resolves", async () => {
    const run = oneAtATime();
    const log: string[] = [];
    const first = deferred();
    const a = run("k", async () => {
      log.push("a start");
      await first.promise;
      log.push("a end");
    });
    const b = run("k", async () => {
      log.push("b start");
    });
    await Promise.resolve();
    expect(log).toEqual(["a start"]);
    first.done();
    await Promise.all([a, b]);
    expect(log).toEqual(["a start", "a end", "b start"]);
  });

  it("lets the next run go after a rejection, and the caller sees it", async () => {
    const run = oneAtATime();
    const a = run("k", () => Promise.reject(new Error("boom")));
    const b = run("k", async () => "ok");
    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe("ok");
  });

  it("turns a synchronous throw into a rejection", async () => {
    const run = oneAtATime();
    await expect(
      run("k", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(await run("k", async () => 1)).toBe(1);
  });

  it("runs different keys at once", async () => {
    const run = oneAtATime();
    const first = deferred();
    let started = false;
    const a = run("a", () => first.promise);
    const b = run("b", async () => {
      started = true;
    });
    await b;
    expect(started).toBe(true);
    first.done();
    await a;
  });
});
