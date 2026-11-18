import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { photoSpecs } from "@justus/core";
import type { WireMessage } from "@ekrooh/bare/core";
import { handleMessage } from "./handle-message";
import { gallery } from "./machines/gallery-machine";
import { sync, syncActor } from "./machines/sync-machine";
import { friendsActor } from "./machines/friends-machine";
import { toast } from "./views/toast";

vi.mock("./views/toast", () => ({ toast: vi.fn() }));

const push = (args: unknown) =>
  ({
    header: {
      type: "DISPATCH",
      pluginId: photoSpecs.changed.pluginId,
      event: photoSpecs.changed.name,
      args,
    },
  }) as unknown as WireMessage;

afterEach(() => vi.restoreAllMocks());

describe("dropped push", () => {
  it("reloads nothing", () => {
    const load = vi.spyOn(gallery, "load").mockImplementation(() => {});
    const refresh = vi.spyOn(sync, "refresh").mockImplementation(() => {});
    handleMessage(
      push({
        cause: "dropped",
        folderId: "f1",
        dropped: { people: [{ key: "k-ben", name: "Ben" }] },
      }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("names a friend as the delete toast just did", () => {
    vi.spyOn(syncActor, "snapshot").mockReturnValue({
      context: {
        status: {
          folder: { id: "f1" },
          members: [
            { key: "k-ada", name: "Ada", admin: true, connected: true },
            { key: "k-ben", name: "Ben", admin: false, connected: true, identity: "id-ben" },
          ],
        },
      },
    } as never);
    vi.spyOn(friendsActor, "snapshot").mockReturnValue({
      context: { friends: { "id-ben": "Benny" } },
    } as never);
    handleMessage(
      push({
        cause: "dropped",
        folderId: "f1",
        dropped: { people: [{ key: "k-ben", name: "Ben" }] },
      }),
    );
    expect(toast).toHaveBeenCalledWith("Removed from Benny's phone.");
  });

  it('never reads "Removed from \'s phone." for a member with no name', () => {
    handleMessage(
      push({
        cause: "dropped",
        folderId: "f1",
        dropped: { people: [{ key: "k-old", name: "" }] },
      }),
    );
    expect(toast).not.toHaveBeenCalledWith("Removed from 's phone.");
  });
});
