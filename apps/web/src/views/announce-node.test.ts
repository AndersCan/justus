import { expect, it } from "vite-plus/test";
import { announce } from "./announce";

it("announce does nothing where there is no document", () => {
  expect(typeof document).toBe("undefined");
  expect(() => announce("Ben, Phone off")).not.toThrow();
});
