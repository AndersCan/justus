/**
 * Web side of the backend -> web contract. The fixture is REAL backend output,
 * captured by `apps/backend/test/contract.integration.test.ts` (which fails when
 * the backend's shape outgrows it). Here the web consumers run on it: the
 * guard, the push router and the machines that read each result.
 */
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { WireMessage } from "@ekrooh/bare/core";
import fixture from "../../../packages/core/fixtures/backend-payloads.json";
import { guardPush, guardResult } from "./contract-guard";
import { handleMessage } from "./handle-message";
import { gateway } from "./gateway";
import {
  $folders,
  $activeFolderId,
  $foldersError,
  $foldersState,
  folders,
} from "./machines/folders-machine";
import { $photos, $galleryState, gallery } from "./machines/gallery-machine";
import { $requests, $requestsState, requests } from "./machines/requests-machine";
import { $syncState, $syncStatus, sync } from "./machines/sync-machine";

const mock = gateway as any;

vi.mock("./gateway", () => ({
  gateway: {
    list: vi.fn(),
    status: vi.fn(),
    folders: vi.fn(),
    requests: vi.fn(),
    join: vi.fn(),
    enroll: vi.fn(),
    createFolder: vi.fn(),
    setActive: vi.fn(),
    setName: vi.fn(),
    respond: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
    addFile: vi.fn(),
    upload: vi.fn(),
    removeMember: vi.fn(),
    media: { pickMany: vi.fn(), capture: vi.fn() },
    logs: { view: vi.fn(), clear: vi.fn() },
    grants: { view: vi.fn() },
  },
}));

const results = fixture.results as Record<string, any[]>;
const withData = (name: string) => results[name].find((r) => JSON.stringify(r).length > 40);

beforeEach(() => vi.restoreAllMocks());

describe("backend fixture through the web guard", () => {
  test.each(Object.entries(results))("%s results pass", (name, samples) => {
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const out = guardResult({ pluginId: "justus.photos", event: name }, [null, sample]);
      expect(out[0], name).toBeNull();
    }
  });

  test("pushes pass", () => {
    expect(fixture.pushes.length).toBeGreaterThan(0);
    for (const p of fixture.pushes) expect(guardPush(p)).toBe(true);
  });

  test("a drifted result names the field and fails the invoke", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = structuredClone(results["photos.status"][0]);
    bad.folder.members = "2";
    const out = guardResult({ pluginId: "justus.photos", event: "photos.status" }, [null, bad]);
    expect(out[0]?.message).toContain("result.folder.members: expected number, got string");
    expect(error).toHaveBeenCalledOnce();
  });

  test("a drifted push is reported and not acted on", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.spyOn(gallery, "load").mockImplementation(() => {});
    handleMessage({
      header: {
        type: "DISPATCH",
        pluginId: "justus.photos",
        event: "photos.changed",
        args: { cause: "rename" },
      },
    } as unknown as WireMessage);
    expect(error.mock.calls[0][0]).toContain("args.cause");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("machines on real backend payloads", () => {
  test("every push refreshes the actors without a contract error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.spyOn(gallery, "load").mockImplementation(() => {});
    const refresh = vi.spyOn(sync, "refresh").mockImplementation(() => {});
    vi.spyOn(folders, "refresh").mockImplementation(() => {});
    vi.spyOn(requests, "refresh").mockImplementation(() => {});
    for (const args of fixture.pushes) {
      handleMessage({
        header: { type: "DISPATCH", pluginId: "justus.photos", event: "photos.changed", args },
      } as unknown as WireMessage);
    }
    expect(error).not.toHaveBeenCalled();
    // Every push refreshes sync; only non-presence pushes reload the gallery.
    expect(refresh).toHaveBeenCalledTimes(fixture.pushes.length);
    expect(load).toHaveBeenCalledTimes(fixture.pushes.filter((p) => p.cause !== "presence").length);
  });

  test("folders: a fresh device (empty active id) and a populated one", async () => {
    mock.folders.mockResolvedValue([null, results["photos.folders"][0]]);
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get(), $foldersError.get() ?? "").toBe("ok"));
    expect($folders.get()).toEqual([]);

    const populated = withData("photos.folders");
    mock.folders.mockResolvedValue([null, populated]);
    folders.refresh();
    await vi.waitFor(() => expect($folders.get().length).toBe(populated.folders.length));
    expect($activeFolderId.get()).toBe(populated.activeFolderId);
  });

  test("sync: status lands in the view model", async () => {
    const status = results["photos.status"][0];
    mock.status.mockResolvedValue([null, status]);
    sync.refresh();
    await vi.waitFor(() => expect($syncState.get()).toBe("ok"));
    expect($syncStatus.get()?.folder.id).toBe(status.folder.id);
    expect($syncStatus.get()?.members.length).toBe(status.members.length);
  });

  test("requests: the Admin's inbox lists the real join request", async () => {
    const inbox = withData("photos.requests");
    mock.requests.mockResolvedValue([null, inbox]);
    requests.refresh();
    await vi.waitFor(() => expect($requestsState.get()).toBe("ok"));
    expect($requests.get().map((r) => r.requesterKey)).toEqual(
      inbox.requests.map((r: any) => r.requesterKey),
    );
  });

  test("gallery: real photos load, each with the fields the views branch on", async () => {
    const listed = withData("photos.list");
    mock.list.mockResolvedValue([null, listed]);
    mock.status.mockResolvedValue([null, results["photos.status"][0]]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).not.toBe("booting"));
    await vi.waitFor(() => expect($photos.get().length).toBe(listed.photos.length));
    for (const p of $photos.get()) {
      expect(p.url).toMatch(/^https?:\/\//);
      expect(p.member.key).toBeTruthy();
      expect(typeof p.mine).toBe("boolean");
    }
  });
});
