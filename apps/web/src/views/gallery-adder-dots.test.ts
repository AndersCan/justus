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
      read: vi.fn(async () => [null, { seen: { version: 1, known: {} } }]),
      write: vi.fn(async () => [null, {}]),
    },
  },
}));

const { photoTile, scopePhotos } = await import("./gallery");
const { galleryActor } = await import("../machines/gallery-machine");
const { memberColor } = await import("../utils/palette");

const photo = (id: string, key: string) => ({
  id,
  name: id,
  folderId: "f1",
  url: "u",
  mine: false,
  member: { key, name: key },
});
const draw = (body: unknown) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(body as never, host);
  return host;
};
const tile = (adder?: { color: number | undefined; name: string }) => {
  const p = photo("b", "kc");
  return draw(photoTile(p as never, [p] as never, adder)).querySelector("figure")!;
};

afterEach(() => document.body.replaceChildren());

describe("photoTile adder", () => {
  it("draws a filled dot in the adder's colour and names them", () => {
    const fig = tile({ color: 1, name: "Cy" });
    const dots = fig.querySelectorAll("[data-adder-dot]");
    expect(dots).toHaveLength(1);
    const dot = dots[0]!;
    expect(dot.getAttribute("data-adder-dot")).toBe("filled");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.className).toContain("ui-presence-dot");
    expect(dot.className).not.toContain("ui-presence-dot-none");
    expect(dot.getAttribute("style")).toContain(memberColor(1)!);
    expect(fig.getAttribute("aria-label")).toBe("View b, added by Cy");
  });

  it("draws a hollow dot for someone without a colour", () => {
    const fig = tile({ color: undefined, name: "Cy" });
    const dot = fig.querySelector("[data-adder-dot]")!;
    expect(dot.getAttribute("data-adder-dot")).toBe("hollow");
    expect(dot.className).toContain("ui-presence-dot-none");
    expect(dot.hasAttribute("style")).toBe(false);
    expect(fig.getAttribute("aria-label")).toBe("View b, added by Cy");
  });

  it("is today's tile without an adder", () => {
    const fig = tile();
    expect(fig.querySelector("[data-adder-dot]")).toBeNull();
    expect(fig.getAttribute("aria-label")).toBe("View b");
  });
});

describe("scopePhotos dots", () => {
  const members = [
    { key: "ka", color: 0 },
    { key: "kc", color: 1 },
  ] as never;
  const drawScope = (adders: string[], withMembers: boolean) => {
    const list = adders.map((k, i) => photo(`p${i}`, k));
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({ context: { photos: list } } as never);
    const host = draw(
      scopePhotos(galleryActor, {
        scope: { kind: "album", id: "f1" },
        sort: "added",
        density: "comfortable" as never,
        empty: () => "",
        members: withMembers ? members : undefined,
      }),
    );
    return host.querySelectorAll("[data-adder-dot]").length;
  };

  it("dots every tile when two people added", () => {
    expect(drawScope(["ka", "kc"], true)).toBe(2);
  });
  it("draws none for one adder, or before the members arrive", () => {
    expect(drawScope(["ka", "ka"], true)).toBe(0);
    expect(drawScope(["ka", "kc"], false)).toBe(0);
  });
});
