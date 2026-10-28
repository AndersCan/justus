import { describe, expect, it } from "vite-plus/test";
import { readProfilePicture, writeProfilePicture } from "./profile-picture";

describe("profile picture", () => {
  it("is empty and does not throw without storage (node)", () => {
    expect(readProfilePicture()).toBe("");
    expect(writeProfilePicture("data:image/jpeg;base64,AA==")).toBe(false);
  });
});
