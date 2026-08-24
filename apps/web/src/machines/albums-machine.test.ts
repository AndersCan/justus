import { describe, expect, test, vi } from "vite-plus/test";
import {
  $albums,
  $activeAlbumId,
  $albumsError,
  $albumsState,
  albums,
  loadAlbums,
  saveAlbums,
  type Album,
} from "./albums-machine";

function findByName(name: string): Album | undefined {
  return $albums.get().find((a) => a.name === name);
}

describe("albums machine", () => {
  test("create adds an album and opens it", () => {
    const before = $albums.get().length;
    albums.create("Trip to Oslo");
    expect($albums.get().length).toBe(before + 1);
    const created = findByName("Trip to Oslo");
    expect(created).toBeDefined();
    expect(created!.photoIds).toEqual([]);
    expect($activeAlbumId.get()).toBe(created!.id);
  });

  test("create rejects an empty name and surfaces an error", () => {
    const before = $albums.get().length;
    albums.create("   ");
    expect($albums.get().length).toBe(before);
    expect(findByName("   ")).toBeUndefined();
    expect($albumsError.get()).toMatch(/empty/i);
    expect($albumsState.get()).toBe("error");
  });

  test("rename updates the album name", () => {
    albums.create("Draft");
    const id = findByName("Draft")!.id;
    albums.rename(id, "Final");
    expect(findByName("Draft")).toBeUndefined();
    expect(findByName("Final")!.id).toBe(id);
  });

  test("remove deletes the album and clears it if active", () => {
    albums.create("ToDelete");
    const id = findByName("ToDelete")!.id;
    expect($activeAlbumId.get()).toBe(id);
    albums.remove(id);
    expect(findByName("ToDelete")).toBeUndefined();
    expect($activeAlbumId.get()).toBeNull();
  });

  test("addPhotos + removePhoto manage membership on the active album", () => {
    albums.create("Mix");
    const id = findByName("Mix")!.id;
    albums.addPhotos(["p1", "p2"]);
    expect(findByName("Mix")!.photoIds).toEqual(["p1", "p2"]);
    // re-adding is idempotent (deduped)
    albums.addPhotos(["p2", "p3"]);
    expect(findByName("Mix")!.photoIds).toEqual(["p1", "p2", "p3"]);
    albums.removePhoto("p2");
    expect(findByName("Mix")!.photoIds).toEqual(["p1", "p3"]);
    expect($albums.get().find((a) => a.id === id)!.id).toBe(id);
  });

  test("addPhotos on no active album is rejected", () => {
    // ensure nothing is active
    const current = $activeAlbumId.get();
    if (current) albums.remove(current);
    expect($activeAlbumId.get()).toBeNull();
    const before = $albums.get().length;
    albums.addPhotos(["x"]);
    expect($albumsError.get()).toMatch(/open an album/i);
    expect($albums.get().length).toBe(before);
  });

  test("persists to localStorage and reloads", () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    });
    try {
      albums.create("Persisted");
      const reloaded = loadAlbums();
      expect(reloaded.find((a) => a.name === "Persisted")).toBeDefined();
      // round-trips through saveAlbums directly too
      saveAlbums($albums.get());
      expect(loadAlbums().find((a) => a.name === "Persisted")).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
