import { expect, test } from "vite-plus/test";
import { formatDay, linkEndText } from "./time";

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

test("formatDay says hours, then the weekday, then the date", () => {
  const now = new Date(2026, 10, 18, 9, 0).getTime();
  const h = 3_600_000;
  expect(formatDay(now - 2 * h, now)).toBe("2 hr ago");
  expect(formatDay(now - 23.9 * h, now)).toBe("23 hr ago");
  expect(formatDay(new Date(2026, 10, 17, 9, 0).getTime(), now)).toBe("Tuesday");
  expect(formatDay(new Date(2026, 10, 14, 20, 0).getTime(), now)).toBe("Saturday");
  expect(formatDay(now - (7 * 24 - 1) * h, now)).toBe("Wednesday");
  expect(formatDay(new Date(2026, 10, 11, 9, 0).getTime(), now)).toBe("November 11, 2026");
});
