import { copy } from "../copy/copy"; /** Warm, human date formatting helpers for the gallery. */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "Just now", "5 min ago", "2 hr ago", "3 days ago", else a short date. */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return copy("time.just_now");
  if (min < 60) return copy("time.min_ago", { min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return copy("time.hr_ago", { hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return copy("time.ago", { days });
  return formatFullDate(ts);
}

/** "August 14, 2026" — used in the lightbox and tooltips. */
export function formatFullDate(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "August 2026" — the gallery's month-group heading. */
export function formatMonthGroup(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** True when two timestamps fall in the same calendar month. */
export function sameMonth(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth();
}

const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** "2 hr ago" under a day, "Monday" for 1-6 days, else the full date. */
export function formatDay(ts: number, now = Date.now()): string {
  const days = Math.floor(Math.max(0, now - ts) / 86_400_000);
  if (days < 1) return formatRelative(ts, now);
  if (days < 7) return WEEKDAYS_LONG[new Date(ts).getDay()];
  return formatFullDate(ts);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** When an invite link ends: "14:05" on the same day as `now`, else "Sat 14 Nov 14:05". */
export function linkEndText(expiresAt: number, now = Date.now()): string {
  const end = new Date(expiresAt);
  const today = new Date(now);
  const hhmm = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    end.getFullYear() === today.getFullYear() &&
    end.getMonth() === today.getMonth() &&
    end.getDate() === today.getDate();
  if (sameDay) return hhmm;
  return `${WEEKDAYS[end.getDay()]} ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${hhmm}`;
}

/** When a link was made, as words that cannot read as a time: "this morning", "yesterday evening", "on 12 Nov", "on 31 Dec 2025". */
export function linkMadeText(madeAt: number, now = Date.now()): string {
  const made = new Date(Math.min(madeAt, now));
  const today = new Date(now);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(made)) / 86_400_000);
  const hour = made.getHours();
  if (days === 0) {
    if (hour < 12) return copy("time.this_morning");
    if (hour < 17) return copy("time.this_afternoon");
    return copy("time.this_evening");
  }
  if (days === 1) {
    if (hour < 12) return copy("time.yesterday_morning");
    if (hour < 17) return copy("time.yesterday_afternoon");
    return copy("time.yesterday_evening");
  }
  const year = made.getFullYear() === today.getFullYear() ? "" : ` ${made.getFullYear()}`;
  return copy("time.on_day", {
    day: `${made.getDate()} ${MONTHS_SHORT[made.getMonth()]}${year}`,
  });
}
