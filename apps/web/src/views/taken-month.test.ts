// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { watch } from "@mantaq/lit";
import { galleryMachine } from "../machines/gallery-machine";
import { prefs, prefsActor } from "../machines/prefs-machine";
import { scopePhotos } from "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));

const rec = (id: string, takenAt?: string) => ({
  id,
  name: `${id}.jpg`,
  folderId: "f1",
  url: `blob:${id}`,
  thumbUrl: `blob:${id}-thumb`,
  addedAt: Date.now(),
  ...(takenAt ? { takenAt } : {}),
});

async function show(records: ReturnType<typeof rec>[]) {
  const port = { ...hoisted.gateway, list: vi.fn(async () => [null, { photos: records }]) };
  const actor = galleryMachine.create({ gateway: port as any });
  const host = document.createElement("div");
  document.body.append(host);
  render(prefsWatch(actor), host);
  (actor as any).send({ type: "LOAD" });
  await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("showingPhotos"));
  return host;
}

function prefsWatch(actor: ReturnType<typeof galleryMachine.create>) {
  return watch(prefsActor, (p) =>
    scopePhotos(actor, {
      scope: { kind: "album", id: "f1" },
      sort: p.context.sort,
      density: "comfortable" as any,
      empty: () => "empty",
    }),
  );
}

const july = (d: number) => `2026-07-0${d}T12:00:00`;
const lineOf = (host: HTMLElement) =>
  [...host.querySelectorAll("button.ui-btn-ghost")].filter((b) =>
    b.textContent?.includes("taken in"),
  );

describe("the taken-month line", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    prefs.showSortForNow("added");
    Element.prototype.scrollIntoView = vi.fn();
  });

  test("a group with 4 photos taken in July shows one line", async () => {
    const host = await show([1, 2, 3, 4].map((d) => rec(`p${d}`, july(d))).concat(rec("x")));
    const lines = lineOf(host);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent?.trim()).toBe("4 taken in July 2026");
  });

  test("photos without a taken date show no line", async () => {
    expect(lineOf(await show([rec("a"), rec("b")]))).toHaveLength(0);
  });

  test("tapping it shows Date taken without saving, and focuses the month heading", async () => {
    const host = await show([1, 2, 3, 4].map((d) => rec(`p${d}`, july(d))));
    (lineOf(host)[0] as HTMLElement).click();
    expect(prefsActor.snapshot().context.sort).toBe("taken");
    expect(localStorage.getItem("justus:photo-sort")).toBeNull();
    await vi.waitFor(() => expect(lineOf(host)).toHaveLength(0));
    expect(document.activeElement).toBe(host.querySelector('h2[data-photo-group="July 2026"]'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
  test("in a group with other photos, tapping focuses the July heading, not the newest one", async () => {
    const host = await show([1, 2, 3, 4].map((d) => rec(`p${d}`, july(d))).concat(rec("x")));
    (lineOf(host)[0] as HTMLElement).click();
    await vi.waitFor(() => expect(lineOf(host)).toHaveLength(0));
    const july2026 = host.querySelector<HTMLElement>('h2[data-photo-group="July 2026"]');
    expect(host.querySelectorAll("h2[data-photo-group]")).toHaveLength(2);
    expect(document.activeElement).toBe(july2026);
    expect(july2026?.getAttribute("tabindex")).toBe("-1");
  });
});
