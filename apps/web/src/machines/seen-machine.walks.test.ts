import { recordRuns } from "@mantaq/inspect/record";
import { expect, test, vi } from "vite-plus/test";
import { seenMachine, isNewPhoto } from "./seen-machine";

vi.mock("../gateway", () => ({
  gateway: {
    seen: {
      read: async () => [null, { seen: { version: 1, known: { summer: ["a"] } } }],
      write: async () => [null, {}],
    },
  },
}));

const make = recordRuns(seenMachine);

test("Ben comes back after Ada added a photo: it is new until he leaves", async () => {
  const actor = make({});
  await actor.settled();
  const photo = { id: "b", folderId: "summer" };
  expect(isNewPhoto(actor.snapshot().context, photo)).toBe(true);
  actor.send({
    type: "PHOTOS_LOOKED",
    payload: { photos: [{ albumId: "summer", photoId: "b" }] },
  } as never);
  expect(isNewPhoto(actor.snapshot().context, photo)).toBe(true);
  actor.send({ type: "VISIT_ENDED" } as never);
  expect(isNewPhoto(actor.snapshot().context, photo)).toBe(false);
});
