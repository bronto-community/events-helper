import { queryCfps, queryEvents } from "./feeds.js";
import { getAllSources } from "./sources.js";
import { OCGROUPS_ENABLED } from "./ocgroups.js";
import { ICAL_ENABLED } from "./ical.js";
import * as store from "./store.js";
import { log } from "./log.js";
import type { Cfp, EventItem } from "./types.js";

// A "source scan": pull everything upcoming across all sources, diff against the
// previous scan (stored in Blob) to find what's new, and produce a summary for
// the ops channel. Runs from a schedule and on demand.

const SNAPSHOT_KEY = "events-helper/scan/last-snapshot.json";
const OCG_SOURCE = "Open Community Groups (ocgroups.dev)";
const MAX_LIST = 8; // cap "what's new" lines per section in the message

interface Snapshot {
  at: number;
  cfpIds: string[];
  eventIds: string[];
}

export interface ScanResult {
  cfpTotal: number;
  eventTotal: number;
  ocgroupsCount: number;
  icalCount: number;
  sourceCount: number;
  newCfps: Cfp[];
  newEvents: EventItem[];
  firstScan: boolean;
  message: string;
}

const cfpId = (c: Cfp): string => c.cfpUrl || `${c.event}|${c.deadline ?? ""}`;
const eventId = (e: EventItem): string => e.url || `${e.name}|${e.dates[0] ?? ""}`;

function formatMessage(r: Omit<ScanResult, "message">): string {
  const lines: string[] = [
    "🔎 *events-helper source scan*",
    `Sources scanned: ${r.sourceCount} · Upcoming CfPs: ${r.cfpTotal} · Upcoming events: ${r.eventTotal} (Open Community Groups: ${r.ocgroupsCount}${r.icalCount ? ` · iCal/Meetup watchlist: ${r.icalCount}` : ""})`,
  ];

  if (r.firstScan) {
    lines.push("_First scan — baseline recorded; new items will be flagged from next scan on._");
    return lines.join("\n");
  }

  if (r.newCfps.length === 0 && r.newEvents.length === 0) {
    lines.push("No new CfPs or events since the last scan.");
    return lines.join("\n");
  }

  if (r.newCfps.length > 0) {
    lines.push("", `*New CfPs (${r.newCfps.length}):*`);
    for (const c of r.newCfps.slice(0, MAX_LIST)) {
      const days = c.daysUntilDeadline !== null ? ` (${c.daysUntilDeadline}d)` : "";
      lines.push(`• ${c.deadline ?? "?"}${days} — ${c.event} — ${c.cfpUrl}`);
    }
    if (r.newCfps.length > MAX_LIST) lines.push(`• …and ${r.newCfps.length - MAX_LIST} more`);
  }

  if (r.newEvents.length > 0) {
    lines.push("", `*New events (${r.newEvents.length}):*`);
    for (const e of r.newEvents.slice(0, MAX_LIST)) {
      lines.push(`• ${e.dates[0] ?? "?"} — ${e.name} — ${e.location || ""} — ${e.url}`);
    }
    if (r.newEvents.length > MAX_LIST) lines.push(`• …and ${r.newEvents.length - MAX_LIST} more`);
  }

  return lines.join("\n");
}

export async function runSourceScan(now: number): Promise<ScanResult> {
  const [cfps, events, sources] = await Promise.all([
    queryCfps({ limit: 5000 }),
    queryEvents({ limit: 5000 }),
    getAllSources(),
  ]);

  const prev = await store.read<Snapshot | null>(SNAPSHOT_KEY, null);
  const firstScan = prev === null;
  const prevCfp = new Set(prev?.cfpIds ?? []);
  const prevEvent = new Set(prev?.eventIds ?? []);
  const newCfps = firstScan ? [] : cfps.filter((c) => !prevCfp.has(cfpId(c)));
  const newEvents = firstScan ? [] : events.filter((e) => !prevEvent.has(eventId(e)));

  await store.write<Snapshot>(SNAPSHOT_KEY, {
    at: now,
    cfpIds: cfps.map(cfpId),
    eventIds: events.map(eventId),
  });

  const ocgroupsCount = events.filter((e) => e.source === OCG_SOURCE).length;
  const icalSourceNames = new Set(
    sources.filter((s) => s.kind === "ical").map((s) => s.name),
  );
  const icalCount = events.filter((e) => icalSourceNames.has(e.source)).length;
  const sourceCount = sources.length + (OCGROUPS_ENABLED ? 1 : 0);

  const base = {
    cfpTotal: cfps.length,
    eventTotal: events.length,
    ocgroupsCount,
    icalCount,
    sourceCount,
    newCfps,
    newEvents,
    firstScan,
  };
  log.info("source scan", {
    "events_helper.scan.cfp_total": base.cfpTotal,
    "events_helper.scan.event_total": base.eventTotal,
    "events_helper.scan.new_cfps": newCfps.length,
    "events_helper.scan.new_events": newEvents.length,
    "events_helper.scan.ocgroups_count": ocgroupsCount,
    "events_helper.scan.ical_count": icalCount,
    "events_helper.scan.ical_enabled": ICAL_ENABLED,
    "events_helper.scan.first": firstScan,
  });
  return { ...base, message: formatMessage(base) };
}
