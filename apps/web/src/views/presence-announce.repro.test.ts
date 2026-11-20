// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { statusSeen, syncActor } from "../machines/sync-machine";
import { statusRegion } from "./announce";
import { startPresenceAnnouncements } from "./presence-changes";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const status = (connected: boolean) =>
  ({
    folder: { id: "f1" },
    members: [
      { key: "me", name: "Ada", admin: true, connected: true },
      { key: "ben", name: "Ben", admin: false, connected, lastSeenAt: Date.now() - 60_000 },
      { key: "cy", name: "Cy", admin: false, connected, lastSeenAt: Date.now() - 60_000 },
    ],
  }) as unknown as SyncStatus;

it("says both phones when two go off in one change (Ada's own network drops)", () => {
  const queued: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => queued.push(cb));
  render(statusRegion(), document.body.appendChild(document.createElement("div")));
  syncActor.send(statusSeen.create({ status: status(true) }));
  const stop = startPresenceAnnouncements();
  syncActor.send(statusSeen.create({ status: status(false) }));
  // One frame: everything written in it is what the screen reader reads.
  for (const cb of queued.splice(0)) cb(0);
  const said = document.querySelector("[data-announce]")?.textContent ?? "";
  stop();
  expect(said).toContain("Ben, ");
  expect(said).toContain("Cy, ");
});
