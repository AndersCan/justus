import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { deletedNote, deletedNoteText } from "./deleted-note";
import { toast } from "./toast";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const photo = (over: Record<string, unknown> = {}) => ({
  name: "Sunset",
  adderName: "Cara",
  mine: false,
  ...over,
});
const album = (photos: ReturnType<typeof photo>[], albumName = "Trip") => ({ albumName, photos });

describe("deletedNoteText", () => {
  test.each([
    [
      [photo({ deletedBy: "Ada" })],
      "Ada deleted “Sunset” from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ deletedBy: "Ada", mine: true })],
      "Ada deleted your photo “Sunset” from Trip. No longer shown on your phone.",
    ],
    [[photo()], "Cara's photo “Sunset” was deleted from Trip. No longer shown on your phone."],
    [
      [photo({ mine: true })],
      "Your photo “Sunset” was deleted from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ deletedBy: "Ada" }), photo({ deletedBy: "Ada" }), photo({ deletedBy: "Ada" })],
      "Ada deleted 3 photos from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ deletedBy: "Ada" }), photo({ deletedBy: "Cara" })],
      "2 photos were deleted from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ deletedBy: "Ada" }), photo()],
      "2 photos were deleted from Trip. No longer shown on your phone.",
    ],
    [[photo(), photo()], "2 photos were deleted from Trip. No longer shown on your phone."],
  ])("one album %#", (photos, text) => {
    expect(deletedNoteText([album(photos)])).toBe(text);
  });

  test.each([
    [
      [photo({ deletedBy: "Ada", held: true })],
      "Ada deleted “Sunset” from Trip. It's removed from your phone.",
    ],
    [
      [photo({ deletedBy: "Ada", mine: true, held: true })],
      "Ada deleted your photo “Sunset” from Trip. It's removed from your phone.",
    ],
    [
      [photo({ deletedBy: "Ada", held: false })],
      "Ada deleted “Sunset” from Trip. It had not reached your phone.",
    ],
    [
      [photo({ deletedBy: "Ada", held: false, preview: true })],
      "Ada deleted “Sunset” from Trip. It's removed from your phone.",
    ],
    [
      [photo({ deletedBy: "Ada", preview: true })],
      "Ada deleted “Sunset” from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ held: false, preview: true }), photo({ held: false, preview: true })],
      "2 photos were deleted from Trip. No longer shown on your phone.",
    ],
    [
      [photo({ held: true }), photo({ held: true })],
      "2 photos were deleted from Trip. No longer shown on your phone.",
    ],
  ])("held %#", (photos, text) => {
    expect(deletedNoteText([album(photos)])).toBe(text);
    expect(deletedNoteText([album(photos)])).not.toContain("here");
  });

  test("one photo in each of two albums stays plain", () => {
    expect(
      deletedNoteText([album([photo({ held: true })]), album([photo({ held: false })], "Home")]),
    ).toBe("2 photos were deleted. No longer shown on your phone.");
  });

  test("no albums make no note", () => {
    expect(deletedNoteText([])).toBe("");
  });

  test("more than one album", () => {
    expect(deletedNoteText([album([photo(), photo()]), album([photo(), photo()], "Home")])).toBe(
      "4 photos were deleted. No longer shown on your phone.",
    );
  });
});

describe("deletedNote.add", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(toast).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  test("two pushes within 300 ms make one toast held 8 s", () => {
    deletedNote.add({ folderId: "f1", ...album([photo({ deletedBy: "Ada" })]) });
    vi.advanceTimersByTime(200);
    deletedNote.add({ folderId: "f1", ...album([photo({ deletedBy: "Ada" })]) });
    vi.advanceTimersByTime(299);
    expect(toast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Ada deleted 2 photos from Trip. No longer shown on your phone.",
      { duration: 8000 },
    );
  });

  test("pushes for two albums merge into one toast", () => {
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    deletedNote.add({ folderId: "f2", ...album([photo()], "Home") });
    vi.advanceTimersByTime(300);
    expect(toast).toHaveBeenCalledWith("2 photos were deleted. No longer shown on your phone.", {
      duration: 8000,
    });
  });

  test("pushes 400 ms apart make two toasts", () => {
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    vi.advanceTimersByTime(400);
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    vi.advanceTimersByTime(400);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(
      "Cara's photo “Sunset” was deleted from Trip. No longer shown on your phone.",
      {
        duration: 8000,
      },
    );
  });
});
