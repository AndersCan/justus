import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createFriendOfferActor } from "./friend-offer-machine";

const NILS = "4e".repeat(32);
const FOLDER = "f1".repeat(32);
const CODE = "c0".repeat(32);

const make = recordRuns(createFriendOfferActor);

test("Nils adds Kari to Lisbon trip as a Viewer, and she joins from her albums list", async () => {
  const actor = make({
    clock: VirtualClock(),
    port: { joinOffer: async () => [null, { ok: true }] },
  });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) =>
    outputs.push({ type: e.type, payload: (e as { payload?: unknown }).payload }),
  );
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };

  await send("join", {
    offer: { code: CODE, owner: NILS, albumName: "Lisbon trip", ownerName: "Nils" },
  });
  await send("askAnswered", { code: CODE, answer: "accepted", folderId: FOLDER });

  expect(actor.state.name).toBe("showingFriendOffers");
  expect(outputs).toEqual([{ type: "openAlbum", payload: { folderId: FOLDER } }]);
});
