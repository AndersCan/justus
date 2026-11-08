import type { JoinRequest } from "@justus/core";
import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { onOutput } from "@mantaq/sugar";
import { expect, test } from "vite-plus/test";
import { acceptAllKeys, createRequestsActor, requestsViewModel } from "./requests-machine";

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
    type: "REVIEW_ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: acceptAllKeys(family, "f1") },
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

test("Three wedding guests ask, and Nils lets all three in as Collaborators at once", async () => {
  const actor = make({ clock: VirtualClock() });
  const toasts: unknown[] = [];
  onOutput(actor, (e) => {
    if (e.type === "ALL_ACCEPTED") toasts.push(e.payload);
  });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: guests } });
  actor.send({
    type: "REVIEW_ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: acceptAllKeys(guests, "f1") },
  });
  actor.send({ type: "PICK_ACCEPT_ALL_ROLE", payload: { role: "member" } });
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
  expect(toasts).toEqual([{ count: 3, role: "member" }]);
});

test("Nils opens Accept all for his family, sees a name he does not know, and cancels", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  actor.send({
    type: "REVIEW_ACCEPT_ALL",
    payload: { folderId: "f1", requesterKeys: acceptAllKeys(family, "f1") },
  });
  actor.send({ type: "CANCEL_ACCEPT_ALL" });
  actor.inject({ type: "REQUESTS_LOADED", payload: { requests: family } });
  await actor.settled();
  const view = requestsViewModel(actor.snapshot());
  expect(view.state).toBe("showingRequests");
  expect(view.requests).toHaveLength(3);
});
