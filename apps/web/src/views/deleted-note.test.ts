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
    [[photo({ deletedBy: "Ada" })], "Ada deleted “Sunset” from Trip."],
    [[photo({ deletedBy: "Ada", mine: true })], "Ada deleted your photo “Sunset” from Trip."],
    [[photo()], "Cara's photo “Sunset” was deleted from Trip."],
    [[photo({ mine: true })], "Your photo “Sunset” was deleted from Trip."],
    [
      [photo({ deletedBy: "Ada" }), photo({ deletedBy: "Ada" }), photo({ deletedBy: "Ada" })],
      "Ada deleted 3 photos from Trip.",
    ],
    [
      [photo({ deletedBy: "Ada" }), photo({ deletedBy: "Cara" })],
      "2 photos were deleted from Trip.",
    ],
    [[photo({ deletedBy: "Ada" }), photo()], "2 photos were deleted from Trip."],
    [[photo(), photo()], "2 photos were deleted from Trip."],
  ])("one album %#", (photos, text) => {
    expect(deletedNoteText([album(photos)])).toBe(text);
  });

  test("more than one album", () => {
    expect(deletedNoteText([album([photo(), photo()]), album([photo(), photo()], "Home")])).toBe(
      "4 photos were deleted.",
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
    expect(toast).toHaveBeenCalledWith("Ada deleted 2 photos from Trip.", { duration: 8000 });
  });

  test("pushes for two albums merge into one toast", () => {
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    deletedNote.add({ folderId: "f2", ...album([photo()], "Home") });
    vi.advanceTimersByTime(300);
    expect(toast).toHaveBeenCalledWith("2 photos were deleted.", { duration: 8000 });
  });

  test("pushes 400 ms apart make two toasts", () => {
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    vi.advanceTimersByTime(400);
    deletedNote.add({ folderId: "f1", ...album([photo()]) });
    vi.advanceTimersByTime(400);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith("Cara's photo “Sunset” was deleted from Trip.", {
      duration: 8000,
    });
  });
});
