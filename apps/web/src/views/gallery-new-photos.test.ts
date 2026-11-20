// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "lit-html";

vi.mock("./looked-at", () => ({ lookedAt: vi.fn(), flushLooked: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    list: vi.fn(),
    add: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
    seen: {
      read: vi.fn(async () => [null, { seen: { version: 1, known: { f1: ["a"] } } }]),
      write: vi.fn(async () => [null, {}]),
    },
  },
}));

const { albumGridBody, photoTile, scopePhotos } = await import("./gallery");
const { galleryActor } = await import("../machines/gallery-machine");
const { lookedAt } = await import("./looked-at");
const { seen, seenActor, seenReady } = await import("../machines/seen-machine");

const photo = (id: string, mine = false) => ({
  id,
  name: id,
  folderId: "f1",
  url: "u",
  mine,
});
const photos = [photo("a"), photo("b"), photo("c", true)];
const f1 = { id: "f1", name: "Trip", role: "creator", members: 2 };
const f2 = { id: "f2", name: "Home", role: "creator", members: 2 };
const other = { ...photo("z"), folderId: "f2" };

const draw = (body: unknown) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(body as never, host);
  return host;
};
const ready = async () => {
  await seenActor.settled();
  expect(seenReady(seenActor.snapshot())).toBe("ready");
};

afterEach(() => document.body.replaceChildren());

const ada = { key: "ka", name: "Ada" };
const cara = { key: "kc", name: "Cara" };
const by = (id: string, member: { key: string; name: string }, mine = false) => ({
  ...photo(id, mine),
  member,
});
const line = async (list: unknown[]) => {
  const { albumHeader } = await import("./gallery");
  const album = { id: "f1", name: "Trip", role: "viewer", members: 2 };
  const status = { folder: { id: "f1" }, members: [] };
  const page = { status, folders: [album], requests: [], photos: list, lastSync: Date.now() };
  const host = draw(albumHeader(page as never, album as never));
  return host.querySelector("[data-new-photos-line]")?.textContent?.replace(/\s+/g, " ").trim();
};

describe("the album's new photos line", () => {
  it("says how many are new and who added them", async () => {
    await ready();
    expect(await line([by("a", ada), by("b", ada), by("c", ada), by("d", cara, true)])).toBe(
      "2 new photos from Ada",
    );
    expect(await line([by("a", ada), by("b", ada), by("c", ada)])).toBe("2 new photos from Ada");
  });

  it("names everyone who added new photos, most first", async () => {
    await ready();
    expect(await line([by("b", ada), by("c", ada), by("d", cara)])).toBe(
      "2 new from Ada, 1 from Cara",
    );
  });

  it("sums past three names as more, and the numbers add up to the New marks", async () => {
    await ready();
    const people = ["p", "q", "r", "s"].map((k) => ({ key: k, name: k.toUpperCase() }));
    const list = people.flatMap((m, i) =>
      Array.from({ length: 4 - i }, (_, j) => by(`${m.key}${j}`, m)),
    );
    expect(await line(list)).toBe("4 new from P, 3 from Q, 2 from R and 1 more");
    const host = draw(list.map((p) => photoTile(p as never, list as never)));
    expect(host.querySelectorAll('[data-copy-id="gallery.new_photo"]')).toHaveLength(10);
  });

  it("sums an unnamed adder as more next to one name", async () => {
    await ready();
    const someone = { key: "kn", name: "New member" };
    expect(await line([by("b", ada), by("c", ada), by("d", someone), by("e", someone)])).toBe(
      "2 new from Ada and 2 more",
    );
  });

  it("is absent with nothing new, and counts one as one", async () => {
    await ready();
    expect(await line([by("a", ada)])).toBeUndefined();
    expect(await line([by("a", ada), by("b", ada)])).toBe("1 new photo from Ada");
  });
});

describe("new photo marks", () => {
  it("marks only a photo that is not the person's own and not known", async () => {
    await ready();
    const host = draw(photos.map((p) => photoTile(p as never, photos as never)));
    const marks = host.querySelectorAll('[data-copy-id="gallery.new_photo"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("[data-photo-tile]")?.getAttribute("data-photo-tile")).toContain("b");
  });

  it("the Albums card says how many are new", async () => {
    await ready();
    const page = { folders: [f1], photos, requests: [], status: null, foldersLoading: false };
    const host = draw(albumGridBody(page as never, seenActor.snapshot().context));
    const card = host.querySelector('[data-album-card="f1"]');
    expect(card?.querySelector('[data-copy-id="gallery.new_count"]')?.textContent).toBe("1 new");
  });

  it("a card with nothing new says nothing, and counts only its own album", async () => {
    await ready();
    const page = {
      folders: [f1, f2],
      photos: [...photos, other],
      requests: [],
      status: null,
      foldersLoading: false,
    };
    const host = draw(albumGridBody(page as never, seenActor.snapshot().context));
    const count = (id: string) =>
      host
        .querySelector(`[data-album-card="${id}"]`)
        ?.querySelector('[data-copy-id="gallery.new_count"]')?.textContent;
    expect(count("f1")).toBe("1 new");
    expect(count("f2")).toBeUndefined();
  });

  it("looking keeps the mark until the visit ends", async () => {
    await ready();
    const host = draw(photoTile(photo("b") as never, photos as never));
    const marks = () => host.querySelectorAll('[data-copy-id="gallery.new_photo"]').length;
    seen.photosLooked([{ albumId: "f1", photoId: "b" }]);
    expect(marks()).toBe(1);
    seen.visitEnded();
    expect(marks()).toBe(0);
  });
});

describe("looks", () => {
  it("the album page counts looks and Photos > All does not", () => {
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({ context: { photos } } as never);
    const drawScope = (scope: never) =>
      draw(
        scopePhotos(galleryActor, {
          scope,
          sort: "added",
          density: "comfortable" as never,
          empty: () => "",
        }),
      );
    vi.mocked(lookedAt).mockClear();
    drawScope({ kind: "all" } as never);
    expect(lookedAt).not.toHaveBeenCalled();
    drawScope({ kind: "album", id: "f1" } as never);
    expect(lookedAt).toHaveBeenCalled();
  });
});

describe("unreadable seen file", () => {
  it("marks and counts nothing", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.seen.read).mockResolvedValueOnce([new Error("x"), null] as never);
    const { seenMachine } = await import("../machines/seen-machine");
    const actor = seenMachine.create({});
    await actor.settled();
    expect(actor.snapshot().context.status).toBe("unreadable");
    const { isNewPhoto, newCount } = await import("../machines/seen-machine");
    expect(isNewPhoto(actor.snapshot().context, photo("b"))).toBe(false);
    expect(newCount(actor.snapshot().context, photos as never)).toBe(0);
  });
});

describe("the album's new photos line after the visit", () => {
  it("is gone once the visit ends", async () => {
    await ready();
    seen.photosLooked([{ albumId: "f1", photoId: "b" }]);
    seen.visitEnded();
    expect(await line([by("a", ada), by("b", ada)])).toBeUndefined();
  });
});

describe("the album's new photos line counts this album only", () => {
  it("leaves out new photos of another album", async () => {
    await ready();
    seen.albumsListed([{ albumId: "f2", photoIds: ["y"] }]);
    const elsewhere = { ...by("z", ada), folderId: "f2" };
    expect(await line([by("a", ada), by("e", ada), elsewhere])).toBe("1 new photo from Ada");
  });
});
