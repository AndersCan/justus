import { describe, expect, it } from "vite-plus/test";
import { justusShareEvents } from "./events";

describe("justusShareEvents.share.send", () => {
  it("targets justus.share with the text as the only arg", () => {
    const envelope = justusShareEvents.share.send("Join me");
    expect(envelope).toMatchObject({ pluginId: "justus.share", event: "share.send" });
    expect(envelope.args).toEqual({ text: "Join me" });
  });
});
