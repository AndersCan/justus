import {
  createAlbumLifecycleActor,
  lifecycleStart,
  type AlbumLifecyclePort,
  type Keep,
  type PortError,
  type Role,
} from "./album-lifecycle-machine";
import { VirtualClock } from "@mantaq/core";
import { Either } from "@mantaq/utils";
import { expectAllStatesReached, expectNoDesignErrors, type InspectTarget } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { describe, expect, test } from "vite-plus/test";

const make = recordRuns(createAlbumLifecycleActor);

type Walker = ReturnType<typeof make>;

async function send(actor: Walker, ...events: Parameters<Walker["send"]>[0][]) {
  for (const e of events) actor.send(e);
  await actor.settled();
}

function seen(role: Role) {
  return { type: "roleSeen", payload: { role } } as const;
}

test("Maya archives Summer and brings it back", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("member"), { type: "archive" });
  expect(actor.state.name).toBe("archived");
  await send(actor, { type: "restore" });
  expect(actor.state.name).toBe("shownInYourAlbums");
});

test("Maya leaves Hytta, and is gone once Nils's phone sees it", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("member"), { type: "leave" });
  expect(actor.state.name).toBe("waitingForAdminToSeeYouLeft");
  await send(actor, { type: "adminSawYouLeave" });
  expect(actor.state.name).toBe("leftAlbum");
});

test("Ben, a Viewer, leaves Hytta, and is gone once Nils's phone sees it", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("reader"), { type: "leave" });
  expect(actor.state.name).toBe("waitingForAdminToSeeYouLeft");
  await send(actor, { type: "adminSawYouLeave" });
  expect(actor.state.name).toBe("leftAlbum");
});

test("Nils deletes Hytta for everyone", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("creator"), { type: "deleteForEveryone" });
  expect(actor.state.name).toBe("deletedForEveryone");
});

test("Maya's phone hears that Nils deleted Hytta, after being away", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("member"), { type: "deleteHeard", payload: { adminName: "Nils" } });
  expect(actor.state.name).toBe("deletedByAdmin");
  expect(actor.snapshot().payload).toEqual({ adminName: "Nils" });
});

test("Maya had archived Hytta when Nils deleted it", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(
    actor,
    seen("member"),
    { type: "archive" },
    { type: "deleteHeard", payload: { adminName: "Nils" } },
  );
  expect(actor.state.name).toBe("deletedByAdmin");
});

test("Maya leaves Hytta, and Nils deletes it before his phone sees her leave", async () => {
  const actor = make({ clock: VirtualClock() });
  await send(actor, seen("member"), { type: "leave" });
  await send(actor, { type: "deleteHeard", payload: { adminName: "Nils" } });
  expect(actor.state.name).toBe("leftAlbum");
});

function recordingPort(options: { failure?: PortError; listed?: boolean } = {}) {
  const calls: string[] = [];
  const failed = options.failure ? Either.left(options.failure) : Either.right();
  const port: AlbumLifecyclePort = {
    adminListsYou: async () => options.listed ?? true,
    writeLeftNote: async () => {
      calls.push("writeLeftNote");
      return failed;
    },
    writeDeleteNote: async () => {
      calls.push("writeDeleteNote");
      return failed;
    },
    removeCopy: async (keep: Keep) => {
      calls.push(`removeCopy:${keep}`);
    },
    forget: async () => {
      calls.push("forget");
    },
  };
  return { port, calls };
}

function plain(role: Role, port: AlbumLifecyclePort) {
  const actor = createAlbumLifecycleActor({
    clock: VirtualClock(),
    port,
    start: { state: "shownInYourAlbums", role },
  });
  return actor;
}

describe("album lifecycle", () => {
  test("Nils cannot leave his own album", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("creator", port);
    actor.send({ type: "leave" });
    await actor.settled();
    expect({ state: actor.state.name, calls }).toEqual({ state: "shownInYourAlbums", calls: [] });
  });

  test("Maya cannot delete Nils's album", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("member", port);
    actor.send({ type: "deleteForEveryone" });
    await actor.settled();
    expect({ state: actor.state.name, calls }).toEqual({ state: "shownInYourAlbums", calls: [] });
  });

  test("the Admin's phone ignores a delete note it wrote itself", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("creator", port);
    actor.send({ type: "deleteHeard", payload: { adminName: "Nils" } });
    await actor.settled();
    expect({ state: actor.state.name, calls }).toEqual({ state: "shownInYourAlbums", calls: [] });
  });

  test("a delete that cannot be written keeps Hytta and says why", async () => {
    const { port, calls } = recordingPort({ failure: { reason: "disk full" } });
    const actor = plain("creator", port);
    actor.send({ type: "deleteForEveryone" });
    await actor.settled();
    expect(actor.state.name).toBe("shownInYourAlbums");
    expect(actor.snapshot().context.error).toBe("disk full");
    expect(calls).toEqual(["writeDeleteNote"]);
  });

  test("a leave that cannot be written keeps Hytta", async () => {
    const { port, calls } = recordingPort({ failure: { reason: "disk full" } });
    const actor = plain("member", port);
    actor.send({ type: "leave" });
    await actor.settled();
    expect(actor.state.name).toBe("shownInYourAlbums");
    expect(actor.snapshot().context.error).toBe("disk full");
    expect(calls).toEqual(["writeLeftNote"]);
  });

  test("a Member's leave writes the note before removing anything", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("member", port);
    actor.send({ type: "leave" });
    await actor.settled();
    actor.send({ type: "adminSawYouLeave" });
    await actor.settled();
    expect(calls).toEqual(["writeLeftNote", "removeCopy:leftNote", "forget"]);
  });

  test("an Admin's delete writes the note before removing anything", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("creator", port);
    actor.send({ type: "deleteForEveryone" });
    await actor.settled();
    expect(calls).toEqual(["writeDeleteNote", "removeCopy:deleteNote"]);
  });

  test("a leave nobody needs to hear removes everything and writes no note", async () => {
    const { port, calls } = recordingPort({ listed: false });
    const actor = plain("reader", port);
    actor.send({ type: "leave" });
    await actor.settled();
    expect(calls).toEqual(["removeCopy:nothing", "forget"]);
    expect(actor.state.name).toBe("leftAlbum");
  });

  test("a listed Viewer's leave writes the note and waits", async () => {
    const { port, calls } = recordingPort();
    const actor = plain("reader", port);
    actor.send({ type: "leave" });
    await actor.settled();
    expect(calls).toEqual(["writeLeftNote", "removeCopy:leftNote"]);
    expect(actor.state.name).toBe("waitingForAdminToSeeYouLeft");
  });

  test("a Viewer's note that cannot be written keeps the album", async () => {
    const { port, calls } = recordingPort({ failure: { reason: "disk full" } });
    const actor = plain("reader", port);
    actor.send({ type: "leave" });
    await actor.settled();
    expect(calls).toEqual(["writeLeftNote"]);
    expect(actor.state.name).toBe("shownInYourAlbums");
    expect(actor.snapshot().context.error).toBe("disk full");
  });

  test("a payload that is not a role is ignored", async () => {
    const actor = plain("member", recordingPort().port);
    actor.send({ type: "roleSeen", payload: { role: "boss" } } as never);
    await actor.settled();
    expect(actor.snapshot().context.role).toBe("member");
  });

  test("a crash during a leave resumes it at boot", async () => {
    const { port, calls } = recordingPort();
    const actor = createAlbumLifecycleActor({
      clock: VirtualClock(),
      port,
      start: lifecycleStart({ role: "member", saved: "leaving" }),
    });
    await actor.settled();
    expect(actor.state.name).toBe("waitingForAdminToSeeYouLeft");
    expect(calls).toEqual(["writeLeftNote", "removeCopy:leftNote"]);
  });

  test("a phone that heard a delete while off resumes removing at boot", async () => {
    const { port, calls } = recordingPort();
    const actor = createAlbumLifecycleActor({
      clock: VirtualClock(),
      port,
      start: lifecycleStart({
        role: "member",
        saved: "shown",
        deleteNote: { adminName: "Nils" },
      }),
    });
    await actor.settled();
    expect(actor.state.name).toBe("deletedByAdmin");
    expect(calls).toEqual(["removeCopy:deleteNote"]);
  });
});

describe("lifecycleStart", () => {
  const nils = { adminName: "Nils" };
  const cases: [string, Parameters<typeof lifecycleStart>[0], string][] = [
    [
      "delete note on a member",
      { role: "member", saved: "shown", deleteNote: nils },
      "removingDeletedAlbum",
    ],
    [
      "delete note beats archived",
      { role: "reader", saved: "archived", deleteNote: nils },
      "removingDeletedAlbum",
    ],
    [
      "delete note on the Admin is ignored",
      { role: "creator", saved: "shown", deleteNote: nils },
      "shownInYourAlbums",
    ],
    ["Admin deleting", { role: "creator", saved: "deleting" }, "deletingForEveryone"],
    ["leaving", { role: "member", saved: "leaving" }, "leavingAlbum"],
    [
      "waiting for the Admin",
      { role: "member", saved: "waitingForAdmin" },
      "waitingForAdminToSeeYouLeft",
    ],
    ["archived", { role: "member", saved: "archived" }, "archived"],
    ["shown", { role: "member", saved: "shown" }, "shownInYourAlbums"],
  ];
  test.each(cases)("%s", (_name, input, expected) => {
    expect(lifecycleStart(input).state).toBe(expected);
  });

  test("a delete note carries the Admin's name", () => {
    expect(lifecycleStart({ role: "member", saved: "shown", deleteNote: nils })).toEqual({
      state: "removingDeletedAlbum",
      role: "member",
      adminName: "Nils",
    });
  });
});

describe("album lifecycle design", () => {
  const target: InspectTarget = {
    id: "albumLifecycle",
    create: () => createAlbumLifecycleActor({ clock: VirtualClock() }),
    payloads: {
      roleSeen: [{ role: "creator" }, { role: "member" }, { role: "reader" }],
      deleteHeard: [{ adminName: "Nils" }],
      leaveSaved: [{ waiting: true }, { waiting: false }],
      leaveFailed: [{ reason: "offline" }],
      deleteFailed: [{ reason: "offline" }],
    },
    tests: [
      {
        name: "Maya leaves Hytta and Nils's phone sees it",
        steps: [
          { kind: "event" as const, event: "roleSeen", payload: { role: "member" } },
          { kind: "event" as const, event: "leave", payload: {} },
          { kind: "event" as const, event: "adminSawYouLeave", payload: {} },
        ],
      },
      {
        name: "Nils deletes Hytta",
        steps: [
          { kind: "event" as const, event: "roleSeen", payload: { role: "creator" } },
          { kind: "event" as const, event: "deleteForEveryone", payload: {} },
        ],
      },
    ],
  };
  test("has no design errors", () => {
    expectNoDesignErrors(target);
  });
  test("reaches every state", () => {
    expectAllStatesReached(target);
  });
});
