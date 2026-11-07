import { expect, test } from "vite-plus/test";
import { linkEndText } from "./time";

test("a link ending later the same day shows only the time", () => {
  const now = new Date(2026, 10, 7, 9, 0).getTime();
  expect(linkEndText(new Date(2026, 10, 7, 14, 5).getTime(), now)).toBe("14:05");
  expect(linkEndText(new Date(2026, 10, 7, 0, 7).getTime(), now)).toBe("00:07");
});

test("a link ending on another day shows weekday, date and time", () => {
  const now = new Date(2026, 10, 7, 9, 0).getTime();
  expect(linkEndText(new Date(2026, 10, 14, 14, 5).getTime(), now)).toBe("Sat 14 Nov 14:05");
  expect(linkEndText(new Date(2027, 0, 1, 8, 30).getTime(), now)).toBe("Fri 1 Jan 08:30");
});
