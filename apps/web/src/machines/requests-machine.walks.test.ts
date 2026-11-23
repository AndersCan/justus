import type { JoinRequest } from "@justus/core";
import { recordRuns } from "@mantaq/inspect/record";
import { onOutput } from "@mantaq/sugar";
import { expect, test } from "vite-plus/test";
import {
  isAcceptedBatch,
  requestsMachine,
  requestsViewModel,
  viewerAcceptKeys,
} from "./requests-machine";

const make = recordRuns(requestsMachine);

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
  const actor = make.create();
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
  const actor = make.create();
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
  const actor = make.create();
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

test("Three wedding guests ask, and Nils accepts all of them as Collaborators at once", async () => {
  const actor = make.create();
  const accepted: unknown[] = [];
  onOutput(actor, (e) => {
    if (e.type === "ALL_ACCEPTED") accepted.push(e.payload);
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: guests } });
  actor.send({
    type: "ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: viewerAcceptKeys(guests, "f1"), role: "member" },
  });
  actor.send({ type: "CONFIRM_ACCEPT_ALL" });
  for (const guest of guests) {
    actor.inject({
      type: "RESPONDED",
      payload: { folderId: "f1", requesterKey: guest.requesterKey },
    });
  }
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [] } });
  await actor.settled();
  expect(requestsViewModel(actor.snapshot()).state).toBe("showingRequests");
  expect(accepted).toEqual([{ count: 3, role: "member" }]);
});

test("Nils's family asks to look, and he accepts all three as Viewers", async () => {
  const actor = make.create();
  const counts: number[] = [];
  onOutput(actor, (e) => {
    if (e.type === "ALL_ACCEPTED" && isAcceptedBatch(e.payload)) counts.push(e.payload.count);
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  actor.send({
    type: "ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: viewerAcceptKeys(family, "f1"), role: "reader" },
  });
  actor.send({ type: "CONFIRM_ACCEPT_ALL" });
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

test("Nils taps Accept all for the family, spots someone he doesn't know and cancels: everyone still waits", async () => {
  const actor = make.create();
  const outputs: string[] = [];
  onOutput(actor, (e) => outputs.push(e.type));
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  actor.send({
    type: "ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: viewerAcceptKeys(family, "f1"), role: "reader" },
  });
  actor.send({ type: "CANCEL_ACCEPT_ALL" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toHaveLength(family.length);
  expect(outputs.filter((type) => type === "ALL_ACCEPTED")).toEqual([]);
});

test("Ana asks while Nils looks at his photos, and Nils hears she wants to join", async () => {
  const ana = ask("Summer", "k7", "Ana");
  const actor = make.create();
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

test("Maya cancels before Nils accepts, and Nils is told", async () => {
  const actor = make.create();
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: [maya] } });
  actor.send({
    type: "RESPOND",
    payload: { folderId: "f1", requesterKey: "k1", approve: true, role: "member" },
  });
  actor.inject({
    type: "REQUEST_WAS_CANCELLED",
    payload: { folderId: "f1", requesterKey: "k1" },
  });
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toEqual([]);
});
