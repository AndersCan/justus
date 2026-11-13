// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumHeader } from "./gallery";
import { friendsActor } from "../machines/friends-machine";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const album = { id: "f1", name: "Trip", role: "creator", members: 1 };
const alone = { folder: { id: "f1" }, members: [{ key: "k0", name: "Me", connected: true }] };
const draw = (requests: unknown[]) => {
  const host = document.createElement("div");
  const page = { status: alone, folders: [album], requests, lastSync: Date.now() };
  render(albumHeader(page as never, album as never), host);
  return host.querySelector("[data-request-line]")?.textContent?.replace(/\s+/g, " ") ?? "";
};

afterEach(() => vi.restoreAllMocks());

describe("albumHeader join request line: who it names", () => {
  test("a saved friend is named by the saved name, not the typed one", () => {
    const snap = friendsActor.snapshot();
    vi.spyOn(friendsActor, "snapshot").mockReturnValue({
      ...snap,
      context: { ...snap.context, friends: { "id-ben": "Ben Smith" } },
    } as never);
    const line = draw([
      { folderId: "f1", folderName: "Trip", requesterName: "phone", requesterIdentity: "id-ben" },
    ]);
    expect(line).toContain("Ben Smith wants to join");
    expect(line).not.toContain("phone");
  });

  test("with two waiting, the line counts them and names neither", () => {
    const line = draw([
      { folderId: "f1", folderName: "Trip", requesterName: "Cy", requestedAt: 2_000 },
      { folderId: "f1", folderName: "Trip", requesterName: "Ben", requestedAt: 1_000 },
    ]);
    expect(line).toContain("2 people want to join");
    expect(line).not.toContain("Ben");
    expect(line).not.toContain("Cy");
  });

  test("with two others connected, the line replaces the connected line", () => {
    const host = document.createElement("div");
    const status = {
      folder: { id: "f1" },
      members: [
        { key: "k0", name: "Me", connected: true },
        { key: "k1", name: "Ada", connected: true },
        { key: "k2", name: "Cy", connected: true },
      ],
    };
    const page = {
      status,
      folders: [{ ...album, members: 3 }],
      requests: [{ folderId: "f1", folderName: "Trip", requesterName: "Ben" }],
      lastSync: Date.now(),
    };
    render(albumHeader(page as never, { ...album, members: 3 } as never), host);
    const text = host.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Ben wants to join");
    expect(text).not.toContain("connected now");
  });
});
