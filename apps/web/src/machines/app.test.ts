import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "@mantaq/core";
import { inspectFile } from "@mantaq/inspect";
import { expect, test } from "vite-plus/test";
import { justusMachine } from "./app";
import { statusSeen } from "./sync-machine";

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

test("onboarding tells folders the name and folders tell sync the status, and every machine is a part", async () => {
  const loaded = await inspectFile(join(here, "app.ts"), { fuzz: false });
  const machine = loaded.machines.find((m) => m.id === "justus");
  expect(machine).toBeDefined();
  const links = Object.entries(machine!.partOutputs).flatMap(([from, events]) =>
    events.flatMap((event) => [
      ...new Set(
        machine!.edges
          .filter((edge) => edge.event === event && edge.from.split(".")[0] !== from)
          .map((edge) => `${from} → ${edge.from.split(".")[0]} ${event}`),
      ),
    ]),
  );
  expect(links.toSorted()).toEqual([
    "folders → sync STATUS_SEEN",
    "onboarding → folders NAME_SEEN",
  ]);
  expect(machine!.regions).toHaveLength(17);
}, 60_000);

test("a saved name reaches folders, a sync status reaches folders and reach, an open sheet asks for requests", async () => {
  const made = justusMachine.create({ clock: VirtualClock() });
  made.onboarding.send({ type: "SKIP" });
  made.onboarding.send({ type: "EDIT_NAME", payload: { name: "Maya" } });
  made.onboarding.send({ type: "SAVE_PROFILE" });
  made.onboarding.inject({ type: "SAVED", payload: { name: "Maya" } });
  await made.onboarding.settled();
  expect(made.folders.snapshot().context.userName).toBe("Maya");

  made.sync.send(statusSeen.create({ status: { name: "Ann", folder: { id: "f1" } } as never }));
  expect(made.folders.snapshot().context.userName).toBe("Ann");

  made.sync.send(
    statusSeen.create({
      status: {
        name: "Ann",
        members: [
          { key: "me", name: "Ann", admin: false, connected: true },
          { key: "a", name: "Maya", admin: true, connected: false },
        ],
      } as never,
    }),
  );
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
