// Shapes for the developers.events feeds and the normalized forms our tools return.

/** A source feed the agent can pull events / CfPs from. */
export interface Source {
  /** Stable identifier, unique across seed + custom sources. */
  id: string;
  /** Human-friendly name shown to the user. */
  name: string;
  /**
   * The feed URL. For `cfps`/`events` this is an HTTPS URL returning a JSON
   * array in the developers.events format; for `ical` it is an iCalendar
   * (`.ics`) feed URL, e.g. a Meetup group's `/events/ical/` calendar.
   */
  url: string;
  /**
   * Which normalized shape this feed produces. `cfps` and `events` are
   * developers.events-shaped JSON; `ical` is any iCalendar feed (produces
   * events) — used for Meetup groups and other calendar-published sources.
   */
  kind: "cfps" | "events" | "ical";
  /**
   * Optional location label applied to every event from this source (e.g.
   * "Berlin"). iCal feeds often omit a venue, and a per-source label also lets
   * location filters match a hand-picked group to the region it meets in.
   */
  location?: string;
  /** Optional extra tags attached to every event from this source (e.g. topics). */
  tags?: string[];
}

// --- Raw feed shapes (developers.events) -----------------------------------

/** A conference block embedded in both feeds. `date` is [startMs] or [startMs, endMs]. */
export interface RawConf {
  name: string;
  date?: number[];
  hyperlink?: string;
  status?: string;
  location?: string;
}

/** One entry in all-cfps.json */
export interface RawCfp {
  link: string;
  until?: string;
  untilDate?: number;
  conf: RawConf;
}

/** One entry in all-events.json */
export interface RawEvent {
  name: string;
  date?: number[];
  hyperlink?: string;
  location?: string;
  city?: string;
  country?: string;
  misc?: string;
  status?: string;
  tags?: string[];
  cfp?: unknown;
}

// --- Normalized shapes our tools return ------------------------------------

export interface Cfp {
  event: string;
  location: string;
  /** ISO date string of the CfP deadline, or null if unknown. */
  deadline: string | null;
  /** Days until the deadline from now (negative = past). */
  daysUntilDeadline: number | null;
  status: string;
  /** ISO date strings for the event itself. */
  eventDates: string[];
  cfpUrl: string;
  eventUrl: string;
  source: string;
}

export interface EventItem {
  name: string;
  location: string;
  country: string;
  /** ISO date strings for the event. */
  dates: string[];
  /** Days until the event starts from now (negative = past). */
  daysUntilStart: number | null;
  status: string;
  tags: string[];
  url: string;
  source: string;
}

/** The user's interest profile, stored durably and used to rank/filter results. */
export interface Interests {
  /** Free-text keywords / technologies the user cares about (matched case-insensitively). */
  keywords: string[];
  /** Preferred locations / regions (e.g. "Europe", "Germany", "Online"). */
  locations: string[];
  /** Anything else the agent should weigh when judging relevance. */
  notes: string;
}

export const DEFAULT_INTERESTS: Interests = {
  keywords: [],
  locations: [],
  notes: "",
};
