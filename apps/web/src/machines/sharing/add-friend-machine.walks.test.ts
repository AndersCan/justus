import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createAddFriendActor } from "./add-friend-machine";

const KARI = "6b".repeat(32);
const OLE = "6f".repeat(32);
const FOLDER = "f1".repeat(32);

const make = recordRuns(createAddFriendActor);

test("Nils adds Kari to Lisbon trip as a Viewer, and she joins from her albums list", async () => {
  const actor = make({
    clock: VirtualClock(),
    port: { offerAlbum: async () => [null, { ok: true }] },
  });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) =>
    outputs.push({ type: e.type, payload: (e as { payload?: unknown }).payload }),
  );
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };

  await send("openPicker", {
    folderId: FOLDER,
    albumName: "Lisbon trip",
    friends: [
      { identity: KARI, name: "Kari" },
      { identity: OLE, name: "Ole" },
    ],
    memberIdentities: [],
  });
  await send("toggleFriend", { identity: KARI });
  await send("pickRole", { role: "reader" });

  expect(actor.state.name).toBe("showingPeopleWithAddFriend");
  expect(outputs).toEqual([{ type: "friendsAsked", payload: { names: ["Kari"], role: "reader" } }]);
});
