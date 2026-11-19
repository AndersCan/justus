import { join } from "node:path";
import { inspectFile } from "@mantaq/inspect";
import { expect, test } from "vite-plus/test";

const loaded = await inspectFile(join(import.meta.dirname, "join-request-machine.ts"), {
  fuzz: false,
});
const edges = loaded.machines.find((m) => m.id === "joinRequest")?.edges ?? [];

test("an answer for another request draws no arrow back to the same state, except joinedAlbum", () => {
  const loops = edges
    .filter((e) => e.event === "requestAnswered" && e.from === e.to && e.from !== "joinedAlbum")
    .map((e) => e.from);
  expect(loops).toEqual([]);
});

test("the join drawing has requestAnswered arrows to read", () => {
  expect(edges.filter((e) => e.event === "requestAnswered").length).toBeGreaterThan(0);
});
