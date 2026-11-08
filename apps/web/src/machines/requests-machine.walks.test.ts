import type { JoinRequest } from "@justus/core";
import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { onOutput } from "@mantaq/sugar";
import { expect, test } from "vite-plus/test";
import {
  collaboratorAcceptKeys,
  createRequestsActor,
  requestsViewModel,
  viewerAcceptKeys,
} from "./requests-machine";

const make = recordRuns(createRequestsActor);

const ask = (folderName: string, requesterKey: string, requesterName: string): JoinRequest => ({
  requesterKey,
  requesterName,
  folderId: "f1",
  folderName,
  shareKey: "s".repeat(64),
  requestedAt: 0,
  viaInvite: true,
});

const maya = ask("Spain 2026", "k1", "Maya");
const guests = [
  ask("Wedding", "k1", "Ola"),
  ask("Wedding", "k2", "Kari"),
  ask("Wedding", "k3", "Per"),
];
const family = [
  ask("Nils's photos", "k1", "Mum"),
  ask("Nils's photos", "k2", "Dad"),
  ask("Nils's photos", "k3", "Sara"),
];

test("Maya asks to join, and Nils accepts her as a Collaborator", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [maya] } });
  actor.send({
    type: "RESPOND",
    payload: { folderId: "f1", requesterKey: "k1", approve: true, role: "member" },
  });
  actor.inject({ type: "RESPONDED", payload: { folderId: "f1", requesterKey: "k1" } });
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toEqual([]);
});

test("Maya: asks and is declined", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [maya] } });
  actor.send({
    type: "RESPOND",
    payload: { folderId: "f1", requesterKey: "k1", approve: false, role: "member" },
  });
  actor.inject({ type: "RESPONDED", payload: { folderId: "f1", requesterKey: "k1" } });
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toEqual([]);
});

test("Three wedding guests ask, and Nils accepts each as a Collaborator", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: guests } });
  for (const guest of guests) {
    actor.send({
      type: "RESPOND",
      payload: { folderId: "f1", requesterKey: guest.requesterKey, approve: true, role: "member" },
    });
    actor.inject({
      type: "RESPONDED",
      payload: { folderId: "f1", requesterKey: guest.requesterKey },
    });
  }
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toEqual([]);
});

test("Nils's family asks to look, and he accepts all three as Viewers", async () => {
  const actor = make({ clock: VirtualClock() });
  const counts: number[] = [];
  onOutput(actor, (e) => {
    if (e.type === "ALL_ACCEPTED") counts.push((e.payload as { count: number }).count);
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  actor.send({
    type: "ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: viewerAcceptKeys(family, "f1"), role: "reader" },
  });
  for (const person of family) {
    actor.inject({
      type: "RESPONDED",
      payload: { folderId: "f1", requesterKey: person.requesterKey },
    });
  }
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [] } });
  await actor.settled();
  expect(requestsViewModel(actor.snapshot()).state).toBe("showingRequests");
  expect(counts).toEqual([3]);
});

test("Thirty friends ask to join the trip album, and Nils accepts them all as Collaborators", async () => {
  const friends = Array.from({ length: 30 }, (_, i) => ask("Trip", `k${i}`, `Friend ${i + 1}`));
  const actor = make({ clock: VirtualClock() });
  const outcome: { count: number; role: string }[] = [];
  onOutput(actor, (e) => {
    if (e.type === "ALL_ACCEPTED") outcome.push(e.payload as { count: number; role: string });
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: friends } });
  actor.send({
    type: "ACCEPT_ALL",
    payload: {
      folderId: "f1",
      requesterKeys: collaboratorAcceptKeys(friends, "f1"),
      role: "member",
    },
  });
  for (const person of friends) {
    actor.inject({
      type: "RESPONDED",
      payload: { folderId: "f1", requesterKey: person.requesterKey },
    });
  }
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [] } });
  await actor.settled();
  expect(requestsViewModel(actor.snapshot()).state).toBe("showingRequests");
  expect(outcome).toEqual([{ count: 30, role: "member" }]);
});

test("Ana asks while Nils looks at his photos, and Nils hears she wants to join", async () => {
  const ana = ask("Summer", "k7", "Ana");
  const actor = make({ clock: VirtualClock() });
  const arrived: string[] = [];
  onOutput(actor, (e) => {
    if (e.type === "REQUESTS_ARRIVED")
      arrived.push(
        ...(e.payload as { requests: JoinRequest[] }).requests.map((r) => r.requesterName),
      );
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [] } });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [ana] } });
  await actor.settled();
  expect(arrived).toEqual(["Ana"]);
  expect(requestsViewModel(actor.snapshot()).state).toBe("showingRequests");
});
