// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "lit-html";

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

const { albumGridBody, photoTile } = await import("./gallery");
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
