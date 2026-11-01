import { describe, expect, test } from "vite-plus/test";
import { renamed } from "./encode-photo";

describe("renamed", () => {
  test("swaps the extension for the shared copy's", () => {
    expect(renamed("IMG_1234.HEIC", ".jpg")).toBe("IMG_1234.jpg");
    expect(renamed("holiday.photo.png", ".jpg")).toBe("holiday.photo.jpg");
    expect(renamed("noext", ".jpg")).toBe("noext.jpg");
    expect(renamed(".hidden", ".jpg")).toBe(".hidden.jpg");
  });
});
