import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "@mantaq/core";
import { inspectFile } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { justusMachine } from "./app";
import { reopenRequest } from "./sharing/join-request-machine";

const here = dirname(fileURLToPath(import.meta.url));

function machineFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__runs__" ? [] : machineFiles(path);
    return entry.name.endsWith("-machine.ts") ? [path] : [];
  });
}

test("the factory returns every machine the app has, the router as its actor", () => {
  const made = justusMachine.create({ clock: VirtualClock() });
  const created = machineFiles(here).flatMap(
    (file) => readFileSync(file, "utf8").match(/export const \w+Machine = machine\(/g) ?? [],
  );
  expect(Object.keys(made).filter((name) => name !== "actor")).toHaveLength(created.length - 1);
  expect(made.actor.snapshot().context).toHaveProperty("page");
});

test("fuzzing finds exactly the six wires between the app's machines", async () => {
  const loaded = await inspectFile(join(here, "app.ts"));
  const machine = loaded.machines.find((m) => m.id === "justus");
  expect(machine).toBeDefined();
  const wires = new Set(
    machine!.fuzz!.messages.map((m) => `${m.from.split(".")[0]} → ${m.to.split(".")[0]}`),
  );
  // One pair per wire in app.ts; a new wire needs a step in the walk below.
  expect([...wires].toSorted()).toEqual([
    "folders → join",
    "folders → sync",
    "onboarding → folders",
    "people → requests",
    "sync → folders",
    "sync → reach",
  ]);
  expect(machine!.regions).toHaveLength(17);
}, 60_000);

const recorded = recordRuns(justusMachine);

test("a saved name, an opened album, a sync status, a waiting request and an open sheet each reach the machine they are wired to", async () => {
  const made = recorded.create({ clock: VirtualClock() });
  made.onboarding.send({ type: "SKIP" });
  made.onboarding.send({ type: "EDIT_NAME", payload: { name: "Maya" } });
  made.onboarding.send({ type: "SAVE_PROFILE" });
  made.onboarding.inject({ type: "SAVED", payload: { name: "Maya" } });
  await made.onboarding.settled();
  expect(made.folders.snapshot().context.userName).toBe("Maya");

  const ask = {
    code: "c1",
    owner: "o1",
    albumName: "Spain",
    ownerName: "Ann",
    askedAt: 1,
    status: "waiting",
  } as const;
  made.join.send(reopenRequest.create({ ask }));
  made.folders.send({ type: "REFRESH" });
  made.folders.inject({
    type: "ALBUMS_LOADED",
    payload: {
      folders: [{ id: "f1", name: "Spain", role: "member", shareKey: "k1" }],
      asks: [{ ...ask, whoMustUpdate: "you" }],
      offers: [],
      activeId: null,
    },
  } as never);
  expect(made.join.snapshot().path[0]).toBe("waitingForYouToUpdate");

  made.folders.send({ type: "SET_ACTIVE", payload: { folderId: "f1" } });
  made.folders.inject({
    type: "SWITCHED",
    payload: {
      status: {
        name: "Ann",
        folder: { id: "f1" },
        members: [
          { key: "me", name: "Ann", admin: false, connected: true },
          { key: "a", name: "Maya", admin: true, connected: false },
        ],
      },
    },
  } as never);
  await made.folders.settled();
  expect(made.sync.snapshot().context.status?.name).toBe("Ann");
  expect(made.folders.snapshot().context.userName).toBe("Ann");
  expect(made.reach.snapshot().path[0]).toBe("tryingToReachMembers");

  expect(made.requests.snapshot().path[0]).toBe("requestsNotLoaded");
  made.people.send({ type: "OPEN" } as never);
  expect(made.requests.snapshot().path[0]).not.toBe("requestsNotLoaded");
});

test("every timed part runs on the clock the app is given", () => {
  const clock = VirtualClock();
  const made = justusMachine.create({ clock });
  const timed = Object.entries(made)
    .filter(([, part]) => part.clock !== undefined)
    .map(([name, part]) => [name, part.clock === clock]);
  expect(Object.fromEntries(timed)).toEqual({
    reach: true,
    join: true,
    friendOffer: true,
    inviteLink: true,
  });
});
