import { errorAttributes, log } from "./log.js";
import * as store from "./store.js";
import type { EventItem } from "./types.js";

// Open Community Groups (https://ocgroups.dev, CNCF) has no public API, but its
// explore map is backed by a JSON search endpoint we can use politely:
//   GET /explore/events/search?limit=<=100&offset=N  ->  { events, total, bbox }
//
// To avoid overwhelming the platform we fetch the whole list in a single
// paginated pass (page size capped at 100) and CACHE it in the durable store with
// a TTL, so no matter how often users query, we hit ocgroups at most ~once per TTL.

const BASE = "https://ocgroups.dev";
const CACHE_KEY = "events-helper/cache/ocgroups-events.json";
const PAGE = 100; // server caps limit at 100
const MAX_PAGES = 5; // safety bound (≤500 events)
const SOURCE_NAME = "Open Community Groups (ocgroups.dev)";
const DAY_MS = 24 * 60 * 60 * 1000;

export const OCGROUPS_ENABLED = process.env.OCGROUPS_ENABLED !== "false";
const TTL_MS = (Number(process.env.OCGROUPS_CACHE_TTL_MIN) || 60) * 60 * 1000;

interface RawOcgEvent {
  name?: string;
  starts_at?: number; // unix seconds
  ends_at?: number;
  kind?: string; // "virtual" | "in-person" | "hybrid"
  canceled?: boolean;
  community_name?: string;
  group_slug?: string;
  slug?: string;
  group_name?: string;
  group_category_name?: string;
  venue_city?: string;
  venue_name?: string;
}

interface OcgCache {
  fetchedAt: number;
  raw: RawOcgEvent[];
}

async function fetchRaw(): Promise<RawOcgEvent[]> {
  const all: RawOcgEvent[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_PAGES && all.length < total; page++) {
    const url = `${BASE}/explore/events/search?limit=${PAGE}&offset=${page * PAGE}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "events-helper/1.0 (+https://events-helper.vercel.app)",
      },
    });
    if (!res.ok) throw new Error(`ocgroups search HTTP ${res.status}`);
    const body = (await res.json()) as { events?: RawOcgEvent[]; total?: number };
    const events = body.events ?? [];
    if (typeof body.total === "number") total = body.total;
    all.push(...events);
    if (events.length < PAGE) break;
  }
  return all;
}

function toIso(sec?: number): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function locationOf(e: RawOcgEvent): string {
  if (e.kind === "virtual") return "Online";
  const loc = [e.venue_name, e.venue_city].filter(Boolean).join(", ");
  if (e.kind === "hybrid") return loc ? `${loc} / Online` : "Hybrid";
  return loc;
}

function toEventItem(e: RawOcgEvent, now: number): EventItem {
  const startMs = typeof e.starts_at === "number" ? e.starts_at * 1000 : undefined;
  const dates = [toIso(e.starts_at), toIso(e.ends_at)].filter((d): d is string => d !== null);
  const url =
    e.community_name && e.group_slug && e.slug
      ? `${BASE}/${e.community_name}/group/${e.group_slug}/event/${e.slug}`
      : BASE;
  return {
    name: e.name ?? "(untitled event)",
    location: locationOf(e),
    country: "",
    dates: [...new Set(dates)],
    daysUntilStart: startMs !== undefined ? Math.round((startMs - now) / DAY_MS) : null,
    status: e.canceled ? "canceled" : "open",
    // group name + category are the topical signal here, so keyword filters
    // (e.g. "kubernetes", "AI") can match them.
    tags: [e.group_name, e.group_category_name].filter((t): t is string => Boolean(t)),
    url,
    source: SOURCE_NAME,
  };
}

/** Cached, normalized events from Open Community Groups. Best-effort: serves stale on fetch error. */
export async function getOcgroupsEvents(now: number): Promise<EventItem[]> {
  if (!OCGROUPS_ENABLED) return [];
  let cache = await store.read<OcgCache | null>(CACHE_KEY, null);
  const fresh = cache !== null && now - cache.fetchedAt < TTL_MS;
  if (!fresh) {
    try {
      const raw = await fetchRaw();
      cache = { fetchedAt: now, raw };
      await store.write(CACHE_KEY, cache);
      log.info("ocgroups events refreshed", {
        "events_helper.ocgroups.event_count": raw.length,
      });
    } catch (err) {
      log.warn("ocgroups fetch failed", {
        ...errorAttributes(err),
        "events_helper.ocgroups.served_stale": cache !== null,
      });
      if (cache === null) return [];
    }
  }
  return (cache?.raw ?? []).map((e) => toEventItem(e, now));
}
