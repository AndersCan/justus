/**
 * A message a phone owes its peer is sent when the phone finishes starting, even if the peer
 * greeted it during start-up. Real Corestore and Hyperswarm, because the fake world connects
 * only after start-up's first steps, so it cannot show the race.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, realNet, type Net } from "./real-peers.ts";
import { albumIn, type Peer } from "./p2p-scenarios.ts";

const nets: Net[] = [];
afterEach(async () => {
  for (const net of nets.splice(0)) await net.destroy();
});

async function ok<T>(result: Promise<readonly [{ message: string } | null, T | null]>): Promise<T> {
  const [err, value] = await result;
  if (err) throw new Error(err.message);
  return value as T;
}

const identityOf = (p: Peer) => (p.store.debugState() as { identityDrive: string }).identityDrive;

/** Who asks with the owner's invite and is let in as a Collaborator; returns the asker's key. */
async function letIn(owner: Peer, who: Peer, folderId: string, code: string) {
  await ok(who.store.ask({ code, owner: identityOf(owner) }));
  const { requests } = await eventually(
    () => owner.store.requests(),
    (r) => r.requests.some((q) => q.requesterName === who.name),
    `${who.name}'s ask on ${owner.name}`,
  );
  const key = requests.find((q) => q.requesterName === who.name)!.requesterKey;
  await ok(owner.store.respond(folderId, key, true, "member"));
  return key;
}

/** How many albums this phone's saved state says it deleted and still has to tell the Admin about. */
function waitingToTell(peer: Peer): number {
  const saved = JSON.parse(readFileSync(join(peer.storageDir, "justus.json"), "utf8")) as {
    gone: { kind: string }[];
  };
  return saved.gone.filter((g) => g.kind === "waitingForAdminToHearYouDeleted").length;
}

describe("a message sent while a phone starts", () => {
  it("Ben joins after Ada accepted while his phone was off, when hers starts with his already on", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const created = await ok(ada.store.createFolder("Trip"));
    const { id: folderId, shareKey, invite } = created.folder;

    await ok(ben.store.ask({ code: invite!.code, owner: identityOf(ada) }));
    const { requests } = await eventually(
      () => ada.store.requests(),
      (r) => r.requests.length > 0,
      "Ben's ask on Ada",
    );
    await ben.stop();
    await ok(ada.store.respond(folderId, requests[0]!.requesterKey, true, "member"));
    await ada.stop();

    const benBack = await net.peer("Ben", ben.storageDir);
    await net.peer("Ada", ada.storageDir);
    await eventually(
      () => albumIn(benBack.store, shareKey),
      (a) => a !== undefined,
      "Ben joined the album",
      30_000,
    );
  }, 150_000);

  it("Ada's phone hears that Ben deleted the album he was removed from, when his starts with hers already on", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const trip = await ok(ada.store.createFolder("Trip"));
    const side = await ok(ada.store.createFolder("Side"));
    const benKey = await letIn(ada, ben, trip.folder.id, trip.folder.invite!.code);
    await letIn(ada, ben, side.folder.id, side.folder.invite!.code);
    for (const album of [trip.folder, side.folder]) {
      await eventually(
        () => albumIn(ben.store, album.shareKey),
        (a) => a?.role === "member",
        `Ben a member of ${album.name}`,
        30_000,
      );
    }

    await ok(ada.store.removeMember(trip.folder.id, benKey));
    const benTrip = await eventually(
      () => albumIn(ben.store, trip.folder.shareKey),
      (a) => a?.notice?.kind === "removed",
      "Ben hears he was removed",
      60_000,
    ).then((a) => a!);
    await ada.stop();
    await ok(ben.store.leaveAlbum(benTrip.id));
    await eventually(
      async () => waitingToTell(ben),
      (n) => n === 1,
      "Ben waiting to tell the Admin",
    );
    await ben.stop();

    await net.peer("Ada", ada.storageDir);
    const benBack = await net.peer("Ben", ben.storageDir);
    await eventually(
      async () => waitingToTell(benBack),
      (n) => n === 0,
      "Ben's delete note heard by Ada",
      30_000,
    );
  }, 180_000);

  it("Ben gets the album Ada started handing to him while his phone was off, when hers starts with his already on", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const side = await ok(ben.store.createFolder("Side"));
    await letIn(ben, ada, side.folder.id, side.folder.invite!.code);
    await eventually(
      () => albumIn(ada.store, side.folder.shareKey),
      (a) => a?.role === "member",
      "Ada a member of Side",
      30_000,
    );
    const summer = await ok(ada.store.createFolder("Summer"));
    const benKey = await letIn(ada, ben, summer.folder.id, summer.folder.invite!.code);
    await eventually(
      () => albumIn(ben.store, summer.folder.shareKey),
      (a) => a?.role === "member",
      "Ben a member of Summer",
      30_000,
    );

    await ben.stop();
    await ok(ada.store.handOver(summer.folder.id, benKey));
    await eventually(
      async () => ada.events.some((e) => e.event === "handover.sent" && e.fields.n === 6),
      Boolean,
      "Ada's retries spent",
      60_000,
    );
    await ada.stop();

    const benBack = await net.peer("Ben", ben.storageDir);
    await net.peer("Ada", ada.storageDir);
    await eventually(
      async () => benBack.events.some((e) => e.event === "handover.ready"),
      Boolean,
      "Ben gets the handover",
      30_000,
    );
  }, 150_000);
});
