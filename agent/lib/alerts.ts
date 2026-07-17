import { getEffective } from "./interests.js";
import { queryCfps, queryEvents } from "./feeds.js";
import * as store from "./store.js";
import type { Cfp, EventItem } from "./types.js";

// Per-user, opt-in CfP alerts. Each subscribed user has a ledger tracking their
// subscription and what we've already told them, so the daily job can send only
// what's new / newly-closing-soon and never repeat itself.

export const ALERTS_ENABLED = process.env.EVENTS_HELPER_ALERTS_ENABLED !== "false";
// Event alerts share the subscription + window/snooze config with CfP alerts,
// but can be turned off independently (they're higher-volume than CfPs).
export const EVENT_ALERTS_ENABLED = process.env.EVENTS_HELPER_EVENT_ALERTS_ENABLED !== "false";
const WINDOW_DAYS = Number(process.env.EVENTS_HELPER_ALERT_WINDOW_DAYS) || 90;
const CLOSING_DAYS = Number(process.env.EVENTS_HELPER_ALERT_CLOSING_DAYS) || 7;
export const SNOOZE_DAYS = Number(process.env.EVENTS_HELPER_SNOOZE_DAYS) || 30;

const LEDGER_PREFIX = "events-helper/alerts/user/";
const ledgerKey = (userId: string) => `${LEDGER_PREFIX}${userId}.json`;

export interface AlertLedger {
  subscribed: boolean;
  at: number; // last alert run for this user (ms)
  notifiedCfpIds: string[]; // CfPs we've sent as "new"
  remindedSoonCfpIds: string[]; // CfPs we've sent a "closing soon" reminder for
  dismissedCfpIds: string[]; // "Not interested" — never alert again
  snoozed: { id: string; until: number }[]; // temporarily muted CfPs/events
  // Event alerts (added later; back-filled to defaults for older ledgers):
  eventBaselineAt: number; // first event-alert run (ms); 0 = not yet baselined
  notifiedEventIds: string[]; // events we've sent as "new"
  dismissedEventIds: string[]; // "Not interested" events — never alert again
}

const EMPTY_LEDGER: AlertLedger = {
  subscribed: false,
  at: 0,
  notifiedCfpIds: [],
  remindedSoonCfpIds: [],
  dismissedCfpIds: [],
  snoozed: [],
  eventBaselineAt: 0,
  notifiedEventIds: [],
  dismissedEventIds: [],
};

/** Stable CfP id — same scheme as lib/scan.ts so ids line up. */
export const cfpId = (c: Cfp): string => c.cfpUrl || `${c.event}|${c.deadline ?? ""}`;

/** Stable event id — same scheme as lib/scan.ts so ids line up. */
export const eventId = (e: EventItem): string => e.url || `${e.name}|${e.dates[0] ?? ""}`;

/** Read a ledger, back-filling any fields missing from older stored ledgers. */
export async function getLedger(userId: string): Promise<AlertLedger> {
  const stored = await store.read<Partial<AlertLedger>>(ledgerKey(userId), {});
  return { ...EMPTY_LEDGER, ...stored };
}

async function updateLedger(
  userId: string,
  fn: (l: AlertLedger) => AlertLedger,
): Promise<AlertLedger> {
  const next = fn(await getLedger(userId));
  await store.write(ledgerKey(userId), next);
  return next;
}

export function isSubscribed(userId: string): Promise<boolean> {
  return getLedger(userId).then((l) => l.subscribed);
}

export function setSubscribed(userId: string, subscribed: boolean): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({ ...l, subscribed }));
}

/** Principal ids of all users who have ever had an alert ledger and are subscribed. */
export async function listSubscribers(): Promise<string[]> {
  const keys = await store.listKeys(LEDGER_PREFIX);
  const ids = keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => k.slice(LEDGER_PREFIX.length, -".json".length));
  const subs: string[] = [];
  for (const id of ids) {
    if (await isSubscribed(id)) subs.push(id);
  }
  return subs;
}

export function markDismissed(userId: string, id: string): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({
    ...l,
    dismissedCfpIds: Array.from(new Set([...l.dismissedCfpIds, id])),
  }));
}

export function markSnoozed(userId: string, id: string, until: number): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({
    ...l,
    snoozed: [...l.snoozed.filter((s) => s.id !== id), { id, until }],
  }));
}

export function markEventDismissed(userId: string, id: string): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({
    ...l,
    dismissedEventIds: Array.from(new Set([...l.dismissedEventIds, id])),
  }));
}

export interface UserAlerts {
  fresh: Cfp[]; // newly matched CfPs (first time)
  closingSoon: Cfp[]; // previously seen, now within CLOSING_DAYS
}

/** Compute what to send a user now, without mutating the ledger. */
export async function computeUserAlerts(userId: string, now: number): Promise<UserAlerts> {
  const effective = await getEffective(userId);
  // No interest signal → don't alert (an empty filter would match everything).
  if (effective.keywords.length === 0 && effective.locations.length === 0) {
    return { fresh: [], closingSoon: [] };
  }
  const ledger = await getLedger(userId);
  const notified = new Set(ledger.notifiedCfpIds);
  const remindedSoon = new Set(ledger.remindedSoonCfpIds);
  const dismissed = new Set(ledger.dismissedCfpIds);
  const activeSnooze = new Set(ledger.snoozed.filter((s) => s.until > now).map((s) => s.id));

  const cfps = await queryCfps({
    keywords: effective.keywords,
    locations: effective.locations,
    withinDays: WINDOW_DAYS,
    limit: 200,
  });

  const blocked = (id: string) => dismissed.has(id) || activeSnooze.has(id);
  const fresh = cfps.filter((c) => !notified.has(cfpId(c)) && !blocked(cfpId(c)));
  const closingSoon = cfps.filter((c) => {
    const id = cfpId(c);
    return (
      notified.has(id) &&
      !remindedSoon.has(id) &&
      !blocked(id) &&
      c.daysUntilDeadline !== null &&
      c.daysUntilDeadline <= CLOSING_DAYS
    );
  });
  return { fresh, closingSoon };
}

/** Record what we actually sent so we don't repeat it next run. */
export function recordAlerted(
  userId: string,
  sent: { freshIds: string[]; soonIds: string[] },
  now: number,
): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({
    ...l,
    at: now,
    notifiedCfpIds: Array.from(new Set([...l.notifiedCfpIds, ...sent.freshIds])),
    remindedSoonCfpIds: Array.from(new Set([...l.remindedSoonCfpIds, ...sent.soonIds])),
  }));
}

export interface UserEventAlerts {
  fresh: EventItem[]; // newly matched events (first time seen after baseline)
  baseline: boolean; // true on the first run for this user — establish, don't send
  currentIds: string[]; // all currently-matching event ids (for baseline recording)
}

/**
 * Compute new matching events for a user, without mutating the ledger.
 * On the first run (`eventBaselineAt === 0`) we return `baseline: true` and send
 * nothing — the caller records the current matches so the user is only alerted
 * about events announced *after* they subscribed, never a backlog flood.
 */
export async function computeUserEventAlerts(userId: string, now: number): Promise<UserEventAlerts> {
  if (!EVENT_ALERTS_ENABLED) return { fresh: [], baseline: false, currentIds: [] };
  const effective = await getEffective(userId);
  if (effective.keywords.length === 0 && effective.locations.length === 0) {
    return { fresh: [], baseline: false, currentIds: [] };
  }
  const ledger = await getLedger(userId);
  const events = await queryEvents({
    keywords: effective.keywords,
    locations: effective.locations,
    withinDays: WINDOW_DAYS,
    limit: 200,
  });
  const currentIds = events.map(eventId);
  if (ledger.eventBaselineAt === 0) {
    return { fresh: [], baseline: true, currentIds };
  }
  const notified = new Set(ledger.notifiedEventIds);
  const dismissed = new Set(ledger.dismissedEventIds);
  const activeSnooze = new Set(ledger.snoozed.filter((s) => s.until > now).map((s) => s.id));
  const fresh = events.filter((e) => {
    const id = eventId(e);
    return !notified.has(id) && !dismissed.has(id) && !activeSnooze.has(id);
  });
  return { fresh, baseline: false, currentIds };
}

/** Record which events we've now told the user about (and stamp the baseline). */
export function recordEventAlerted(userId: string, ids: string[], now: number): Promise<AlertLedger> {
  return updateLedger(userId, (l) => ({
    ...l,
    eventBaselineAt: l.eventBaselineAt === 0 ? now : l.eventBaselineAt,
    notifiedEventIds: Array.from(new Set([...l.notifiedEventIds, ...ids])),
  }));
}
