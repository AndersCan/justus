import { describe, it, expect, vi } from "vite-plus/test";
import { photoSpecs } from "@justus/core";
import type { WireMessage } from "@ekrooh/bare/core";
import { askAnswer, changeCause, handleMessage } from "./handle-message";
import { friendOffer } from "./machines/sharing/friend-offer";
import { join } from "./machines/sharing/join-request";

const push = (args: unknown) =>
  ({
    header: {
      type: "DISPATCH",
      pluginId: photoSpecs.changed.pluginId,
      event: photoSpecs.changed.name,
      args,
    },
  }) as unknown as WireMessage;

describe("handleMessage", () => {
  it("passes the Admin's accepted answer to the friend invite and the join request", () => {
    const offer = vi.spyOn(friendOffer, "askAnswered").mockImplementation(() => {});
    const request = vi.spyOn(join, "requestAnswered").mockImplementation(() => {});
    handleMessage(push({ cause: "ask", code: "c", answer: "accepted", folderId: "f" }));
    expect(offer).toHaveBeenCalledWith("c", "accepted", "f");
    expect(request).toHaveBeenCalledWith("c", "accepted", "f");
    offer.mockRestore();
    request.mockRestore();
  });

  it("passes a link-off answer to the join request and not the friend invite", () => {
    const offer = vi.spyOn(friendOffer, "askAnswered").mockImplementation(() => {});
    const request = vi.spyOn(join, "requestAnswered").mockImplementation(() => {});
    handleMessage(push({ cause: "ask", code: "c", answer: "linkOff" }));
    expect(request).toHaveBeenCalledWith("c", "linkOff", undefined);
    expect(offer).not.toHaveBeenCalled();
    offer.mockRestore();
    request.mockRestore();
  });

  it("does not answer an invite for a push without an answer", () => {
    const offer = vi.spyOn(friendOffer, "askAnswered").mockImplementation(() => {});
    handleMessage(push({ cause: "add" }));
    expect(offer).not.toHaveBeenCalled();
    offer.mockRestore();
  });
});

describe("changeCause", () => {
  it("reads the cause from a dispatch header", () => {
    expect(changeCause({ args: { cause: "presence" } })).toBe("presence");
  });

  it("ignores headers without one", () => {
    expect(changeCause({})).toBeUndefined();
    expect(changeCause({ args: { cause: 3 } })).toBeUndefined();
  });
});

describe("askAnswer", () => {
  it("reads an accepted answer with its album", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "accepted", folderId: "f" })).toEqual({
      code: "c",
      answer: "accepted",
      folderId: "f",
    });
  });
  it("reads a declined answer without a folder", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "declined" })).toEqual({
      code: "c",
      answer: "declined",
      folderId: undefined,
    });
  });
  it("reads a link-off answer without a folder", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "linkOff" })).toEqual({
      code: "c",
      answer: "linkOff",
      folderId: undefined,
    });
  });
  it.each([
    undefined,
    { cause: "add", code: "c", answer: "accepted" },
    { cause: "ask", answer: "accepted" },
    { cause: "ask", code: "c" },
    { cause: "ask", code: "c", answer: "maybe" },
  ])("ignores %j", (args) => {
    expect(askAnswer(args)).toBeUndefined();
  });
});
