// Date labels for anything a human reads.
//
// Feed dates are bare `YYYY-MM-DD` strings, which are precise but hard to plan
// against: "2026-09-18" doesn't tell you it's a Friday. Every user-facing date
// therefore carries its weekday.
//
// Parsing is pinned to UTC. A date-only string has no timezone, so letting the
// runtime interpret it locally would shift it a day west of Greenwich and print
// the wrong weekday — on Vercel the process runs in UTC, but a laptop running
// `eve dev` does not, and a weekday that changes with the reader's machine is
// worse than none.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Short weekday name for an ISO date, or null when it isn't a date we can read. */
export function weekday(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(ms)) return null;
  return WEEKDAYS[new Date(ms).getUTCDay()] ?? null;
}

/** `2026-09-18` → `Fri 2026-09-18`. Unparseable input is passed through as-is. */
export function withWeekday(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = weekday(iso);
  return day ? `${day} ${iso}` : iso;
}

/**
 * A run of event dates as one label: `Mon 2027-03-15 → Thu 2027-03-18`.
 * Only the first and last matter — feeds list either a single day or a span,
 * and spelling out every day in between reads as noise.
 */
export function dateRangeLabel(dates: string[] | null | undefined): string {
  if (!dates || dates.length === 0) return "";
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!last || last === first) return withWeekday(first);
  return `${withWeekday(first)} → ${withWeekday(last)}`;
}

/**
 * A moment in time as a readable, UTC-pinned label: `Tue 2026-09-15 07:00 UTC`.
 * Used for the timestamps a human reads (when a scan ran, when a rule was added)
 * — an ISO string with milliseconds and a `T` in it is a machine format.
 */
export function timestampLabel(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const iso = new Date(ms).toISOString();
  const day = WEEKDAYS[new Date(ms).getUTCDay()];
  return `${day} ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
