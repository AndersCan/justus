import { describe, it, expect, vi } from "vite-plus/test";
import { photoSpecs } from "@justus/core";
import type { WireMessage } from "@ekrooh/bare/core";
import { askAnswer, changeCause, deletedOf, handleMessage, roleChangeOf } from "./handle-message";
import { deletedNote } from "./views/deleted-note";
import { roleToast } from "./views/role-toast";
import { friendOffer } from "./machines/sharing/friend-offer";
import { join } from "./machines/sharing/join-request";
import { gallery } from "./machines/gallery-machine";
import { folders } from "./machines/folders-machine";

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
    expect(request).toHaveBeenCalledWith({ code: "c", answer: "accepted", folderId: "f" });
    offer.mockRestore();
    request.mockRestore();
  });

  it("passes a declined answer to the join request and the friend invite", () => {
    const offer = vi.spyOn(friendOffer, "askAnswered").mockImplementation(() => {});
    const request = vi.spyOn(join, "requestAnswered").mockImplementation(() => {});
    handleMessage(push({ cause: "ask", code: "c", answer: "declined" }));
    expect(request).toHaveBeenCalledWith({ code: "c", answer: "declined" });
    expect(offer).toHaveBeenCalledWith("c", "declined");
    offer.mockRestore();
    request.mockRestore();
  });

  it("passes a link-off answer to the join request and not the friend invite", () => {
    const offer = vi.spyOn(friendOffer, "askAnswered").mockImplementation(() => {});
    const request = vi.spyOn(join, "requestAnswered").mockImplementation(() => {});
    handleMessage(push({ cause: "ask", code: "c", answer: "linkOff", why: "replaced" }));
    expect(request).toHaveBeenCalledWith({ code: "c", answer: "linkOff", why: "replaced" });
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

describe("handleMessage holders", () => {
  it("a holders push reloads the gallery and not the albums", () => {
    const load = vi.spyOn(gallery, "load").mockImplementation(() => {});
    const refresh = vi.spyOn(folders, "refresh").mockImplementation(() => {});
    handleMessage(push({ cause: "holders" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    load.mockRestore();
    refresh.mockRestore();
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
    });
  });
  it("reads a link-off answer without a reason", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "linkOff" })).toEqual({
      code: "c",
      answer: "linkOff",
      why: undefined,
    });
  });
  it.each(["expired", "turnedOff", "replaced", "albumDeleted"])(
    "keeps the link-off reason %s",
    (why) => {
      expect(askAnswer({ cause: "ask", code: "c", answer: "linkOff", why })).toEqual({
        code: "c",
        answer: "linkOff",
        why,
      });
    },
  );
  it.each(["removed", 3, null])("drops the unknown link-off reason %s", (why) => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "linkOff", why })).toEqual({
      code: "c",
      answer: "linkOff",
      why: undefined,
    });
  });
  it("reads a reason only on a link-off answer", () => {
    expect(askAnswer({ cause: "ask", code: "c", answer: "declined", why: "replaced" })).toEqual({
      code: "c",
      answer: "declined",
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

describe("handleMessage role", () => {
  const role = { from: "member", to: "reader", albumName: "Summer", adminName: "Anna" };

  it("a role push tells the role toast", () => {
    const spy = vi.spyOn(roleToast, "changed").mockImplementation(() => {});
    handleMessage(push({ cause: "role", folderId: "f1", role }));
    expect(spy).toHaveBeenCalledWith({ ...role, folderId: "f1" });
    spy.mockRestore();
  });

  it("other pushes do not", () => {
    const spy = vi.spyOn(roleToast, "changed").mockImplementation(() => {});
    handleMessage(push({ cause: "enroll", folderId: "f1" }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("roleChangeOf needs a folder id and a role object", () => {
    expect(roleChangeOf({ cause: "role", folderId: "f1", role })).toEqual({
      ...role,
      folderId: "f1",
    });
    expect(roleChangeOf({ cause: "role", role })).toBeUndefined();
    expect(roleChangeOf({ cause: "role", folderId: "f1" })).toBeUndefined();
    expect(roleChangeOf({ cause: "role", folderId: "f1", role: null })).toBeUndefined();
    expect(roleChangeOf({ cause: "add", folderId: "f1", role })).toBeUndefined();
    expect(roleChangeOf(undefined)).toBeUndefined();
  });
});

describe("handleMessage deleted", () => {
  const deleted = {
    albumName: "Trip",
    photos: [{ name: "a.png", adderName: "Anna", mine: false, deletedBy: "Anna" }],
  };

  it("a deleted push tells the note and reloads nothing", () => {
    const spy = vi.spyOn(deletedNote, "add").mockImplementation(() => {});
    const load = vi.spyOn(gallery, "load").mockImplementation(() => {});
    handleMessage(push({ cause: "deleted", folderId: "f1", deleted }));
    expect(spy).toHaveBeenCalledWith({ ...deleted, folderId: "f1" });
    expect(load).not.toHaveBeenCalled();
    spy.mockRestore();
    load.mockRestore();
  });

  it("deletedOf needs a folder id and a deleted object", () => {
    expect(deletedOf({ cause: "deleted", deleted })).toBeUndefined();
    expect(deletedOf({ cause: "deleted", folderId: "f1" })).toBeUndefined();
    expect(deletedOf({ cause: "enroll", folderId: "f1", deleted })).toBeUndefined();
    expect(deletedOf({ cause: "deleted", folderId: "f1", deleted: null })).toBeUndefined();
  });
});
