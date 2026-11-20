// @vitest-environment happy-dom
import { render } from "lit-html";
import { expect, test, vi } from "vite-plus/test";

const SAM = "a".repeat(64);
vi.mock("../gateway", () => {
  const any = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === "then" ? undefined : any()),
      apply: () => Promise.resolve([null, {}]),
    });
  const friends = {
    list: vi.fn(async () => [null, { friends: [{ identity: SAM, name: "Sam" }] }]),
    words: vi.fn(async () => [null, { words: "early steel produce clap" }]),
    add: vi.fn(),
    remove: vi.fn(),
  };
  return { gateway: new Proxy({}, { get: (_t, k) => (k === "friends" ? friends : any()) }) };
});

test("Settings page: tapping a friend opens the sheet with the words", async () => {
  const { settingsView } = await import("./settings");
  const { friendsActor } = await import("../machines/friends-machine");
  await friendsActor.settled();
  const host = document.createElement("div");
  document.body.append(host);
  render(settingsView(), host);
  await vi.waitFor(() => expect(host.querySelector("[data-friend-open]")).not.toBeNull());
  host.querySelector<HTMLButtonElement>("[data-friend-open]")!.click();
  await vi.waitFor(() =>
    expect(host.querySelector("[data-friend-words]")?.textContent).toBe("early steel produce clap"),
  );
});
