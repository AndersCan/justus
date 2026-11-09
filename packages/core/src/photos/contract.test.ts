import { describe, expect, it } from "vite-plus/test";
import fixture from "../../fixtures/backend-payloads.json";
import { checkPhotoChanged, checkPhotoResult, photoResultSchemas } from "./contract";
import { photoSpecs } from "./events";

describe("photo contract", () => {
  it("has a result schema for every invoke spec (and none for the push)", () => {
    const invokes = Object.values(photoSpecs)
      .map((spec) => spec.name)
      .filter((name) => name !== photoSpecs.changed.name);
    expect(Object.keys(photoResultSchemas).sort()).toEqual(invokes.sort());
  });

  it("accepts the real backend fixture", () => {
    for (const [name, samples] of Object.entries(fixture.results)) {
      for (const sample of samples) expect(checkPhotoResult(name, sample)).toBeNull();
    }
    for (const push of fixture.pushes) expect(checkPhotoChanged(push)).toBeNull();
  });

  it("names the offending field", () => {
    expect(checkPhotoResult("photos.list", { photos: [{ id: "a" }] })).toBe(
      "photos.list contract violation: result.photos[0].url: missing required field",
    );
    expect(
      checkPhotoResult("photos.folders", {
        folders: [],
        archived: [],
        deleted: [],
        activeFolderId: null,
      }),
    ).toContain("result.activeFolderId: expected string, got null");
    expect(checkPhotoChanged({ cause: "rename" })).toContain("args.cause: expected one of");
    expect(checkPhotoChanged("nope")).toContain("args: expected object, got string");
  });

  it("accepts a role push and names a bad role", () => {
    const role = { from: "member", to: "reader", albumName: "A" };
    expect(checkPhotoChanged({ cause: "role", folderId: "f", role })).toBeNull();
    expect(
      checkPhotoChanged({ cause: "role", folderId: "f", role: { ...role, to: "creator" } }),
    ).toContain("args.role.to");
  });

  it("accepts linkOff as an ask answer and status", () => {
    expect(checkPhotoChanged({ cause: "ask", code: "c", answer: "linkOff" })).toBeNull();
    const ask = {
      code: "c",
      owner: "o",
      albumName: "a",
      ownerName: "n",
      askedAt: 1,
      status: "linkOff",
    };
    expect(
      checkPhotoResult("photos.folders", {
        folders: [],
        archived: [],
        deleted: [],
        activeFolderId: null,
        asks: [ask],
      }),
    ).not.toContain("status");
  });

  it("checks the reason a link stopped on pushes and asks", () => {
    expect(
      checkPhotoChanged({ cause: "ask", code: "c", answer: "linkOff", why: "replaced" }),
    ).toBeNull();
    expect(
      checkPhotoChanged({ cause: "ask", code: "c", answer: "linkOff", why: "nope" }),
    ).toContain("args.why");
    const ask = {
      code: "c",
      owner: "o",
      albumName: "a",
      ownerName: "n",
      askedAt: 1,
      status: "linkOff",
      why: "turnedOff",
      closed: true,
    };
    const folders = {
      folders: [],
      archived: [],
      deleted: [],
      activeFolderId: "",
      asks: [ask],
      offers: [],
    };
    expect(checkPhotoResult("photos.folders", folders)).toBeNull();
    expect(
      checkPhotoResult("photos.folders", { ...folders, asks: [{ ...ask, why: "nope" }] }),
    ).toContain("why");
    expect(
      checkPhotoResult("photos.folders", { ...folders, asks: [{ ...ask, closed: "yes" }] }),
    ).toContain("closed");
  });

  it("checks the optional check code on requests and asks", () => {
    const request = {
      requesterKey: "k",
      requesterName: "n",
      folderId: "f",
      folderName: "Trip",
      shareKey: "s",
      requestedAt: 1,
    };
    expect(checkPhotoResult("photos.requests", { requests: [request] })).toBeNull();
    expect(
      checkPhotoResult("photos.requests", {
        requests: [{ ...request, checkCode: "maple river stone" }],
      }),
    ).toBeNull();
    const ask = {
      code: "c",
      owner: "o",
      albumName: "a",
      ownerName: "n",
      askedAt: 1,
      status: "waiting",
      checkCode: 5,
    };
    expect(
      checkPhotoResult("photos.folders", {
        folders: [],
        archived: [],
        deleted: [],
        activeFolderId: "f",
        asks: [ask],
      }),
    ).toContain("checkCode");
  });

  it("ignores unknown extra fields", () => {
    expect(checkPhotoResult("photos.setName", { name: "x", extra: 1 })).toBeNull();
  });
});

describe("deleted push", () => {
  const deleted = {
    albumName: "Trip",
    photos: [
      { name: "a.jpg", adderName: "Ann", mine: false, deletedBy: "Ann" },
      { name: "b.jpg", adderName: "Bo", mine: true, held: true },
    ],
  };

  it("accepts a deleted push and names a bad field", () => {
    expect(checkPhotoChanged({ cause: "deleted", folderId: "f", deleted })).toBeNull();
    expect(
      checkPhotoChanged({
        cause: "deleted",
        folderId: "f",
        deleted: { ...deleted, photos: [{ name: "a", adderName: "A", mine: "yes" }] },
      }),
    ).toContain("args.deleted.photos[0].mine");
  });
});
