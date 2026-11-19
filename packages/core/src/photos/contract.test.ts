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

  it("accepts quiet holders and names a bad lastSeenAt", () => {
    const photo = {
      id: "a",
      url: "u",
      name: "n",
      mime: "m",
      size: 1,
      addedAt: 0,
      member: { key: "k", name: "N" },
    };
    const holders = (lastSeenAt: unknown) => ({
      photos: [
        {
          ...photo,
          holders: {
            kind: "inAlbum",
            here: true,
            previewHere: false,
            others: [{ key: "a", name: "Ada", connected: true, identity: "id-a", color: 3 }],
            yourColor: 0,
            quiet: [
              { key: "b", name: "Ben", connected: false, lastSeenAt, identity: "id-b", color: 1 },
            ],
            unsure: [],
            waiting: [],
            previews: [],
            former: [],
            left: [],
          },
        },
      ],
    });
    expect(checkPhotoResult("photos.list", holders(1))).toBeNull();
    expect(checkPhotoResult("photos.list", holders("x"))).toContain("holders.quiet[0].lastSeenAt");
  });

  it("names a bad colour on a holders entry and a bad yourColor", () => {
    const photo = {
      id: "a",
      url: "u",
      name: "n",
      mime: "m",
      size: 1,
      addedAt: 0,
      member: { key: "k", name: "N" },
    };
    const holders = (color: unknown, yourColor: unknown) => ({
      photos: [
        {
          ...photo,
          holders: {
            kind: "inAlbum",
            here: true,
            previewHere: false,
            others: [{ key: "a", name: "Ada", connected: true, color }],
            quiet: [],
            unsure: [],
            waiting: [],
            previews: [],
            former: [],
            left: [],
            yourColor,
          },
        },
      ],
    });
    expect(checkPhotoResult("photos.list", holders(3, 0))).toBeNull();
    expect(checkPhotoResult("photos.list", holders("red", 0))).toContain("holders.others[0].color");
    expect(checkPhotoResult("photos.list", holders(3, "x"))).toContain("holders.yourColor");
  });

  it("checks the presence on a waiting entry", () => {
    const photo = {
      id: "a",
      url: "u",
      name: "n",
      mime: "m",
      size: 1,
      addedAt: 0,
      member: { key: "k", name: "N" },
    };
    const list = (entry: unknown) => ({
      photos: [
        {
          ...photo,
          holders: {
            kind: "inAlbum",
            here: true,
            previewHere: false,
            others: [],
            quiet: [],
            unsure: [],
            waiting: [entry],
            previews: [],
            former: [],
            left: [],
          },
        },
      ],
    });
    const ben = { key: "b", name: "Ben" };
    expect(checkPhotoResult("photos.list", list({ ...ben, connected: true }))).toBeNull();
    expect(
      checkPhotoResult("photos.list", list({ ...ben, connected: false, lastSeenAt: 5 })),
    ).toBeNull();
    expect(checkPhotoResult("photos.list", list({ ...ben, connected: "yes" }))).toContain(
      "holders.waiting[0].connected",
    );
    expect(checkPhotoResult("photos.list", list(ben))).toContain(
      "holders.waiting[0].connected: missing required field",
    );
  });

  it("accepts removed holders and names a bad kind", () => {
    const photo = {
      id: "a",
      url: "u",
      name: "n",
      mime: "m",
      size: 1,
      addedAt: 0,
      member: { key: "k", name: "N" },
    };
    const list = (holders: unknown) => ({ photos: [{ ...photo, holders }] });
    expect(checkPhotoResult("photos.list", list({ kind: "removed", here: true }))).toBeNull();
    expect(checkPhotoResult("photos.list", list({ kind: "other", here: true }))).toBe(
      'photos.list contract violation: result.photos[0].holders.kind: expected one of inAlbum|removed, got "other"',
    );
    expect(
      checkPhotoResult("photos.list", list({ kind: "inAlbum", here: true, previewHere: false })),
    ).toBe(
      "photos.list contract violation: result.photos[0].holders.others: missing required field",
    );
    expect(checkPhotoResult("photos.list", list(null))).toBe(
      "photos.list contract violation: result.photos[0].holders: expected object, got null",
    );
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
      checkPhotoChanged({
        cause: "role",
        folderId: "f",
        role: { ...role, from: "member", to: "creator" },
      }),
    ).toBeNull();
    expect(
      checkPhotoChanged({ cause: "role", folderId: "f", role: { ...role, to: "admin" } }),
    ).toContain("args.role.to");
  });

  it("accepts the ids a person still has to drop and names a bad one", () => {
    const status = (stillToDrop: unknown) => ({
      folder: {
        id: "f",
        name: "A",
        role: "creator",
        shareKey: "s",
        driveKey: "d",
        members: 2,
        addedAt: 1,
      },
      name: "Ada",
      driveKey: "d",
      discoveryKey: "k",
      peers: 0,
      photos: 0,
      members: [{ key: "b", name: "Ben", admin: false, connected: false, stillToDrop }],
      updateNeeded: false,
      peersBehind: [],
    });
    expect(checkPhotoResult("photos.status", status(["p1"]))).toBeNull();
    expect(checkPhotoResult("photos.status", status("p1"))).toContain("members[0].stillToDrop");
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

describe("dropped push", () => {
  const dropped = { people: [{ key: "k", name: "Ben" }] };

  it("accepts a dropped push and names a bad field", () => {
    expect(checkPhotoChanged({ cause: "dropped", folderId: "f", dropped })).toBeNull();
    expect(
      checkPhotoChanged({ cause: "dropped", folderId: "f", dropped: { ...dropped, people: "x" } }),
    ).toContain("args.dropped.people");
  });
});
