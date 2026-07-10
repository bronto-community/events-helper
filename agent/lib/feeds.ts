import type {
  Cfp,
  EventItem,
  RawCfp,
  RawEvent,
  Source,
} from "./types.js";
import { getAllSources } from "./sources.js";
import { errorAttributes, log } from "./log.js";
import { OCGROUPS_ENABLED, getOcgroupsEvents } from "./ocgroups.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysFromNow(ms: number | undefined, now: number): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return Math.round((ms - now) / DAY_MS);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return res.json();
}

function normalizeCfp(raw: RawCfp, source: Source, now: number): Cfp | null {
  if (!raw?.conf) return null;
  return {
    event: raw.conf.name ?? "(unknown)",
    location: raw.conf.location ?? "",
    deadline: toIso(raw.untilDate),
    daysUntilDeadline: daysFromNow(raw.untilDate, now),
    status: raw.conf.status ?? "",
    eventDates: (raw.conf.date ?? []).map((d) => toIso(d)).filter((d): d is string => d !== null),
    cfpUrl: raw.link ?? "",
    eventUrl: raw.conf.hyperlink ?? "",
    source: source.name,
  };
}

function normalizeEvent(raw: RawEvent, source: Source, now: number): EventItem | null {
  if (!raw?.name) return null;
  const start = raw.date?.[0];
  return {
    name: raw.name,
    location: raw.location ?? "",
    country: raw.country ?? "",
    dates: (raw.date ?? []).map((d) => toIso(d)).filter((d): d is string => d !== null),
    daysUntilStart: daysFromNow(start, now),
    status: raw.status ?? "",
    tags: raw.tags ?? [],
    url: raw.hyperlink ?? "",
    source: source.name,
  };
}

export interface CfpQuery {
  /** Case-insensitive substrings matched against event name + location. */
  keywords?: string[];
  /** Case-insensitive substrings matched against the location. */
  locations?: string[];
  /** Only CfPs whose deadline is within this many days from now. */
  withinDays?: number;
  /** Include CfPs whose deadline has already passed. Default false. */
  includePast?: boolean;
  /** Cap on returned rows after sorting by soonest deadline. Default 50. */
  limit?: number;
}

export interface EventQuery {
  keywords?: string[];
  locations?: string[];
  withinDays?: number;
  includePast?: boolean;
  limit?: number;
}

function matchesText(haystack: string, needles?: string[]): boolean {
  if (!needles || needles.length === 0) return true;
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

/** Fetch, normalize, filter and sort CfPs across every configured CfP source. */
export async function queryCfps(query: CfpQuery = {}): Promise<Cfp[]> {
  const now = Date.now();
  const limit = query.limit ?? 50;
  const sources = await getAllSources("cfps");

  const perSource = await Promise.all(
    sources.map(async (source) => {
      try {
        const data = await fetchJson(source.url);
        if (!Array.isArray(data)) {
          log.warn("cfp source returned non-array", {
            "events_helper.source.name": source.name,
            "url.full": source.url,
          });
          return [] as Cfp[];
        }
        return data
          .map((raw) => normalizeCfp(raw as RawCfp, source, now))
          .filter((c): c is Cfp => c !== null);
      } catch (err) {
        log.warn("cfp source fetch failed", {
          "events_helper.source.name": source.name,
          "url.full": source.url,
          ...errorAttributes(err),
        });
        return [] as Cfp[];
      }
    }),
  );

  let cfps = perSource.flat();

  if (!query.includePast) {
    cfps = cfps.filter((c) => c.daysUntilDeadline !== null && c.daysUntilDeadline >= 0);
  }
  if (typeof query.withinDays === "number") {
    cfps = cfps.filter(
      (c) => c.daysUntilDeadline !== null && c.daysUntilDeadline <= query.withinDays!,
    );
  }
  cfps = cfps.filter(
    (c) =>
      matchesText(`${c.event} ${c.location}`, query.keywords) &&
      matchesText(c.location, query.locations),
  );

  cfps.sort((a, b) => {
    const av = a.daysUntilDeadline ?? Number.POSITIVE_INFINITY;
    const bv = b.daysUntilDeadline ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });

  const returned = cfps.slice(0, limit);
  log.info("cfps queried", {
    "events_helper.query.source_count": sources.length,
    "events_helper.query.matched": cfps.length,
    "events_helper.query.returned": returned.length,
    "events_helper.query.keywords": query.keywords,
    "events_helper.query.locations": query.locations,
    "events_helper.query.within_days": query.withinDays,
    "events_helper.query.include_past": query.includePast ?? false,
  });
  return returned;
}

/** Fetch, normalize, filter and sort events across every configured events source. */
export async function queryEvents(query: EventQuery = {}): Promise<EventItem[]> {
  const now = Date.now();
  const limit = query.limit ?? 50;
  const sources = await getAllSources("events");

  const perSource = await Promise.all(
    sources.map(async (source) => {
      try {
        const data = await fetchJson(source.url);
        if (!Array.isArray(data)) {
          log.warn("events source returned non-array", {
            "events_helper.source.name": source.name,
            "url.full": source.url,
          });
          return [] as EventItem[];
        }
        return data
          .map((raw) => normalizeEvent(raw as RawEvent, source, now))
          .filter((e): e is EventItem => e !== null);
      } catch (err) {
        log.warn("events source fetch failed", {
          "events_helper.source.name": source.name,
          "url.full": source.url,
          ...errorAttributes(err),
        });
        return [] as EventItem[];
      }
    }),
  );

  let events = perSource.flat();

  // Open Community Groups (cached, single JSON pull) — merged with the feed events.
  if (OCGROUPS_ENABLED) {
    events = events.concat(await getOcgroupsEvents(now));
  }

  if (!query.includePast) {
    events = events.filter((e) => e.daysUntilStart !== null && e.daysUntilStart >= 0);
  }
  if (typeof query.withinDays === "number") {
    events = events.filter(
      (e) => e.daysUntilStart !== null && e.daysUntilStart <= query.withinDays!,
    );
  }
  events = events.filter(
    (e) =>
      matchesText(`${e.name} ${e.location} ${e.tags.join(" ")}`, query.keywords) &&
      matchesText(`${e.location} ${e.country}`, query.locations),
  );

  events.sort((a, b) => {
    const av = a.daysUntilStart ?? Number.POSITIVE_INFINITY;
    const bv = b.daysUntilStart ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });

  const returned = events.slice(0, limit);
  log.info("events queried", {
    "events_helper.query.source_count": sources.length,
    "events_helper.query.ocgroups_enabled": OCGROUPS_ENABLED,
    "events_helper.query.matched": events.length,
    "events_helper.query.returned": returned.length,
    "events_helper.query.keywords": query.keywords,
    "events_helper.query.locations": query.locations,
    "events_helper.query.within_days": query.withinDays,
    "events_helper.query.include_past": query.includePast ?? false,
  });
  return returned;
}
