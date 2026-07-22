import { errorAttributes, log } from "./log.js";
import * as store from "./store.js";
import type { EventItem, Source } from "./types.js";

// Generic iCalendar (RFC 5545) event source. Any public `.ics` feed becomes an
// events source: we fetch it, parse the VEVENTs, normalize to EventItem, and
// cache per-source in the durable store with a TTL so we poll politely (a feed
// is meant to be subscribed to, not hammered).
//
// Meetup groups publish exactly such a feed at `/<group>/events/ical/`, so a
// hand-picked watchlist of groups is just a set of iCal sources — nothing
// Meetup-specific downstream. `toIcalUrl` adds the one convenience: paste a
// Meetup group URL/slug and we resolve its calendar feed.

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "events-helper/cache/ical/";

export const ICAL_ENABLED = process.env.ICAL_ENABLED !== "false";
const TTL_MS = (Number(process.env.ICAL_CACHE_TTL_MIN) || 60) * 60 * 1000;

interface IcalCache {
  fetchedAt: number;
  ics: string;
}

/** Small deterministic hash → stable, filesystem-safe cache key per feed URL. */
function keyFor(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${CACHE_PREFIX}${(h >>> 0).toString(16)}.json`;
}

const lumaIcsUrl = (calId: string) =>
  `https://api.lu.ma/ics/get?entity=calendar&id=${calId}`;

/**
 * Resolve user input to an iCal feed URL — synchronous cases only. A Meetup
 * group URL or `meetup:<slug>` becomes that group's calendar feed; a
 * `luma:<cal-id>` shorthand becomes that Luma calendar's ICS endpoint; anything
 * else is returned as-is. Luma *page* URLs need a fetch to discover the calendar
 * id — use `resolveIcalUrl` for those.
 */
export function toIcalUrl(input: string): string {
  const raw = input.trim();
  const meetupShorthand = raw.match(/^meetup:([\w-]+)$/i);
  if (meetupShorthand) {
    return `https://www.meetup.com/${meetupShorthand[1]}/events/ical/`;
  }
  const meetupUrl = raw.match(/^https?:\/\/(?:www\.)?meetup\.com\/([^/?#]+)/i);
  if (meetupUrl) {
    return `https://www.meetup.com/${meetupUrl[1]}/events/ical/`;
  }
  const lumaShorthand = raw.match(/^luma:(cal-[A-Za-z0-9]+)$/i);
  if (lumaShorthand) {
    return lumaIcsUrl(lumaShorthand[1]);
  }
  return raw;
}

/**
 * Async resolver used when adding a source. Handles everything `toIcalUrl` does,
 * plus Luma calendar *page* URLs (`luma.com/<slug>` / `lu.ma/<slug>`): it fetches
 * the page and extracts the calendar's `api_id` to build the ICS endpoint. Throws
 * if a Luma page has no discoverable calendar id.
 */
export async function resolveIcalUrl(input: string): Promise<string> {
  const raw = input.trim();
  const lumaPage = raw.match(/^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/(?!discover\/|event\/)([^/?#]+)/i);
  if (lumaPage && !/api\.lu\.ma/i.test(raw)) {
    const res = await fetch(raw, {
      headers: { accept: "text/html", "user-agent": "events-helper/1.0 (+https://events-helper-brontoio.vercel.app)" },
    });
    if (!res.ok) throw new Error(`Luma page HTTP ${res.status}`);
    const html = await res.text();
    // The calendar's own api_id is the first `"api_id":"cal-…"` in the page JSON.
    const m = html.match(/"api_id":"(cal-[A-Za-z0-9]+)"/);
    if (!m) throw new Error("Could not find a Luma calendar id on that page (is it a calendar URL?)");
    return lumaIcsUrl(m[1]);
  }
  return toIcalUrl(raw);
}

// --- RFC 5545 parsing ------------------------------------------------------

/** Unfold folded lines: a line beginning with a space or tab continues the previous one. */
function unfold(ics: string): string[] {
  const lines = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

interface RawProp {
  value: string;
  params: Record<string, string>;
}

/** Split an unfolded content line into name, parameters, and value. */
function parseLine(line: string): { name: string; prop: RawProp } | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, prop: { value, params } };
}

/**
 * Parse an iCal datetime to epoch ms and an ISO date (YYYY-MM-DD).
 * Handles `YYYYMMDDTHHMMSSZ` (UTC), `YYYYMMDDTHHMMSS` (floating/TZID — treated
 * as UTC, fine at day granularity), and `YYYYMMDD` (date only). Timezone offset
 * is ignored: every downstream use is day-level, so a few hours never matters.
 */
function parseDate(prop: RawProp): { ms: number; iso: string } | null {
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mm = "00", ss = "00"] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  if (!Number.isFinite(ms)) return null;
  return { ms, iso: `${y}-${mo}-${d}` };
}

interface RawVevent {
  uid?: string;
  summary?: string;
  location?: string;
  url?: string;
  status?: string;
  start?: { ms: number; iso: string };
  end?: { ms: number; iso: string };
}

function parseVevents(ics: string): RawVevent[] {
  const events: RawVevent[] = [];
  let cur: RawVevent | null = null;
  for (const line of unfold(ics)) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, prop } = parsed;
    switch (name) {
      case "UID":
        cur.uid = prop.value.trim();
        break;
      case "SUMMARY":
        cur.summary = unescapeText(prop.value);
        break;
      case "LOCATION":
        cur.location = unescapeText(prop.value);
        break;
      case "URL":
        cur.url = prop.value.trim();
        break;
      case "STATUS":
        cur.status = prop.value.trim().toUpperCase();
        break;
      case "DTSTART":
        cur.start = parseDate(prop) ?? undefined;
        break;
      case "DTEND":
        cur.end = parseDate(prop) ?? undefined;
        break;
    }
  }
  return events;
}

function toEventItem(e: RawVevent, source: Source, now: number): EventItem | null {
  if (!e.start) return null; // an event with no start is not actionable
  const dates = [e.start.iso, e.end?.iso].filter((d): d is string => Boolean(d));
  // Some providers (e.g. Luma) put the event page URL in LOCATION rather than a
  // venue. If LOCATION is a URL and there's no explicit URL, treat it as the
  // event link and fall back to the source's location label for the location.
  let loc = e.location ?? "";
  let url = e.url ?? "";
  if (!url && /^https?:\/\//i.test(loc)) {
    url = loc;
    loc = "";
  }
  return {
    name: e.summary || "(untitled event)",
    location: loc || source.location || "",
    country: "",
    dates: [...new Set(dates)],
    daysUntilStart: Math.round((e.start.ms - now) / DAY_MS),
    status: e.status === "CANCELLED" ? "canceled" : "open",
    tags: source.tags ?? [],
    url: url || source.url,
    source: source.name,
  };
}

// --- Fetch + cache ---------------------------------------------------------

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      accept: "text/calendar, text/plain, */*",
      "user-agent": "events-helper/1.0 (+https://events-helper-brontoio.vercel.app)",
    },
  });
  if (!res.ok) throw new Error(`iCal fetch HTTP ${res.status}`);
  return res.text();
}

/** Cached, normalized events from one iCal source. Best-effort: serves stale on error, [] if never fetched. */
export async function getIcalEvents(source: Source, now: number): Promise<EventItem[]> {
  const cacheKey = keyFor(source.url);
  let cache = await store.read<IcalCache | null>(cacheKey, null);
  const fresh = cache !== null && now - cache.fetchedAt < TTL_MS;
  if (!fresh) {
    try {
      const ics = await fetchIcs(source.url);
      cache = { fetchedAt: now, ics };
      await store.write(cacheKey, cache);
      log.info("ical source refreshed", {
        "events_helper.source.name": source.name,
        "url.full": source.url,
        "events_helper.ical.byte_count": ics.length,
      });
    } catch (err) {
      log.warn("ical source fetch failed", {
        "events_helper.source.name": source.name,
        "url.full": source.url,
        "events_helper.ical.served_stale": cache !== null,
        ...errorAttributes(err),
      });
      if (cache === null) return [];
    }
  }
  return parseVevents(cache?.ics ?? "")
    .map((e) => toEventItem(e, source, now))
    .filter((e): e is EventItem => e !== null);
}

/**
 * Validate an iCal feed URL by fetching it once. Used when adding a source so
 * we reject dead/private feeds immediately (Meetup private groups return
 * `403 Invalid feed signature`). Returns the count of upcoming VEVENTs.
 */
export async function validateIcal(url: string): Promise<{ ok: true; upcoming: number } | { ok: false; error: string }> {
  try {
    const ics = await fetchIcs(url);
    const now = Date.now();
    const upcoming = parseVevents(ics).filter((e) => e.start && e.start.ms >= now - DAY_MS).length;
    return { ok: true, upcoming };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
