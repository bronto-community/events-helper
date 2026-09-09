import { eventId } from "./ids.js";
import { log } from "./log.js";
import * as store from "./store.js";
import type { EventItem } from "./types.js";

// Spam filtering (and duplicate collapsing) for events.
//
// A curated watchlist of public calendars picks up junk alongside the real
// community events: the same "webinar" cross-posted to a dozen city groups by
// one person, a paid training dressed up as a meetup, an "online" session
// advertised under a city that nobody can attend there.
//
// It also picks up honest *duplicates* — several aggregator calendars listing the
// same real local meetup. Those are collapsed by `dedupeEvents` before anything
// is judged: they're noise rather than spam, and left in place they would look
// exactly like cross-posting to the heuristics below.
//
// Two layers, both applied on *every* read (`queryEvents`), so filtering keeps
// working on its own for every future scan, digest and alert — not just once:
//
//  1. HEURISTICS — signals scored per event. Strong signals (weight 2) drop an
//     event on their own; weak ones (weight 1) only drop it when a second signal
//     agrees. A price tag is deliberately weak: real conferences charge money.
//  2. RULES — a durable, team-wide list (`block` / `allow`) so a verdict sticks
//     for good, and so false positives can be pinned back into view. Rules match
//     an exact event id, a title, an organizer, a URL host, or a whole source.
//
// Nothing is silently swallowed: every drop carries the signals that caused it,
// and the daily source scan reports the tally to the ops channel.

export const SPAM_FILTER_ENABLED = process.env.EVENTS_HELPER_SPAM_FILTER_ENABLED !== "false";
/** How many distinct sources the same listing must appear in to count as cross-posted. */
const CROSSPOST_MIN = Number(process.env.EVENTS_HELPER_SPAM_CROSSPOST_MIN) || 3;
/** Score at which an event is dropped. Strong signal = 2, weak = 1. */
const THRESHOLD = Number(process.env.EVENTS_HELPER_SPAM_THRESHOLD) || 2;

const RULES_KEY = "events-helper/spam/rules.json";
const REPORT_KEY = "events-helper/spam/last-report.json";

// --- Rules -----------------------------------------------------------------

export type RuleMatch = "event_id" | "title" | "organizer" | "url_host" | "source";

export interface SpamRule {
  /** Deterministic id derived from kind+match+value, so re-adding a rule is a no-op. */
  id: string;
  kind: "block" | "allow";
  match: RuleMatch;
  /** Normalized comparison value. For `title` it matches as a substring. */
  value: string;
  reason?: string;
  /** Principal id that added the rule. */
  by: string;
  at: number;
}

export interface NewSpamRule {
  kind: "block" | "allow";
  match: RuleMatch;
  value: string;
  reason?: string;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Lowercase, strip punctuation/emoji, collapse whitespace — for stable comparisons. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The values a rule can match against, for one event. */
function matchValues(e: EventItem): Record<RuleMatch, string> {
  return {
    event_id: eventId(e),
    title: norm(e.name),
    organizer: norm(e.organizer ?? ""),
    url_host: hostOf(e.url),
    source: norm(e.source),
  };
}

function ruleMatches(rule: SpamRule, values: Record<RuleMatch, string>): boolean {
  const value = values[rule.match];
  if (!value) return false;
  // Titles match as substrings (a spam listing is often re-posted with a city or
  // date appended); everything else is an exact match.
  return rule.match === "title" ? value.includes(rule.value) : value === rule.value;
}

/** Normalize a rule's value the same way the event side is normalized. */
function normalizeRuleValue(match: RuleMatch, value: string): string {
  if (match === "event_id") return value.trim();
  if (match === "url_host") return hostOf(value.includes("://") ? value : `https://${value}`) || value.trim().toLowerCase();
  return norm(value);
}

export async function listRules(): Promise<SpamRule[]> {
  return store.read<SpamRule[]>(RULES_KEY, []);
}

/** Add rules, ignoring ones already present. Returns the full list plus what was new. */
export async function addRules(
  input: NewSpamRule[],
  by: string,
  now: number,
): Promise<{ rules: SpamRule[]; added: SpamRule[] }> {
  const existing = await listRules();
  const seen = new Set(existing.map((r) => r.id));
  const added: SpamRule[] = [];
  for (const r of input) {
    const value = normalizeRuleValue(r.match, r.value);
    if (!value) continue;
    const id = `${r.kind[0]}${hash(`${r.kind}|${r.match}|${value}`)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({ id, kind: r.kind, match: r.match, value, reason: r.reason, by, at: now });
  }
  if (added.length === 0) return { rules: existing, added };
  const rules = [...existing, ...added];
  await store.write(RULES_KEY, rules);
  log.info("spam rules added", {
    "user.id": by,
    "events_helper.spam.rules_added": added.length,
    "events_helper.spam.rules_total": rules.length,
  });
  return { rules, added };
}

export async function removeRule(id: string, by: string): Promise<{ removed: SpamRule | null; rules: SpamRule[] }> {
  const existing = await listRules();
  const removed = existing.find((r) => r.id === id) ?? null;
  if (!removed) return { removed, rules: existing };
  const rules = existing.filter((r) => r.id !== id);
  await store.write(RULES_KEY, rules);
  log.info("spam rule removed", {
    "user.id": by,
    "events_helper.spam.rule_id": id,
    "events_helper.spam.rules_total": rules.length,
  });
  return { removed, rules };
}

/**
 * The rules to write when someone flags one event as spam: the exact listing,
 * plus its title when that title is distinctive enough to be safe as a pattern
 * (so the same junk re-posted elsewhere or next month is caught too).
 */
export function rulesFromEvent(e: EventItem, reason?: string): NewSpamRule[] {
  return rulesFromIdAndTitle(eventId(e), e.name, reason);
}

/** Same, from the id + title carried in a Slack button payload. */
export function rulesFromIdAndTitle(id: string, name: string, reason?: string): NewSpamRule[] {
  const rules: NewSpamRule[] = [{ kind: "block", match: "event_id", value: id, reason }];
  const title = norm(name);
  if (isDistinctiveTitle(title)) rules.push({ kind: "block", match: "title", value: title, reason });
  return rules;
}

// --- Heuristics ------------------------------------------------------------

export type Signal = "cross_posted" | "cross_posted_series" | "virtual_in_city" | "paid" | "promo";

const WEIGHTS: Record<Signal, number> = {
  cross_posted: 2, // same listing in ≥ CROSSPOST_MIN calendars — strong on its own
  cross_posted_series: 1, // same title in many calendars on different dates — weak
  virtual_in_city: 1, // online session advertised under a physical city — weak
  paid: 1, // has a price tag — weak by design, real conferences charge
  promo: 1, // marketing/hype/course-selling language — weak
};

const SIGNAL_LABELS: Record<Signal, string> = {
  cross_posted: "cross-posted across calendars",
  cross_posted_series: "same title in many calendars",
  virtual_in_city: "online event advertised under a city",
  paid: "has a ticket price",
  promo: "promotional/course-selling wording",
};

/**
 * Titles too generic to group on: half the meetup groups in Europe run a
 * "monthly meetup", and three of them landing on the same evening must not look
 * like one thing cross-posted.
 */
const GENERIC_TITLES = new Set([
  "meetup",
  "monthly meetup",
  "monthly meetup online",
  "community meetup",
  "community night",
  "meetup night",
  "coffee and code",
  "hack night",
  "open house",
  "social",
  "networking",
  "networking event",
  "lightning talks",
  "office hours",
  "stammtisch",
  "watch party",
  "demo day",
  "kickoff",
  "annual general meeting",
]);

function isDistinctiveTitle(title: string): boolean {
  if (GENERIC_TITLES.has(title)) return false;
  return title.length >= 12 && title.split(" ").length >= 2;
}

const VIRTUAL_RE =
  /\b(online|virtual|remote|zoom|webinar|web ?cast|livestream|live stream|google meet|ms teams|microsoft teams|teams meeting|twitch|youtube live)\b/i;

/**
 * Explicit "you attend this from your desk" phrasing, for descriptions. A blurb
 * merely *mentioning* online is not evidence: a real conference writes "also
 * available online" about its stream, and must not be treated as a fake meetup.
 */
const VIRTUAL_DESC_RE =
  /\b(join (?:us )?(?:on|via) (?:zoom|google meet|ms teams|microsoft teams|teams)|zoom link|meeting link will|(?:this|the) (?:event|session|meetup|talk) (?:is|will be) (?:fully |entirely )?online|online[- ]only|fully online|held online|streamed live|live ?stream(?:ing|ed)? (?:on|via)|register to (?:receive|get) the link|webinar)\b/i;

const PROMO_RE =
  /\b(masterclass|master class|bootcamp|certification (?:training|course|program)|exam (?:prep|voucher)|placement (?:assistance|guarantee)|100% (?:job|placement)|guaranteed (?:job|income|results)|limited seats|hurry up|dm me|whats ?app (?:me|group)|passive income|make money|earn \$?\d|forex|crypto (?:signals|pump|trading course)|mlm|network marketing|lead generation|affiliate)\b/i;

const FREE_RE = /\b(free (?:entry|event|admission|to attend|of charge|for all)|no (?:cost|charge)|kostenlos|gratis)\b/i;

const PRICE_RES: RegExp[] = [
  /[€$£]\s?[1-9]\d*(?:[.,]\d{2})?/,
  /\b[1-9]\d*(?:[.,]\d{2})?\s?(?:eur|usd|gbp|euros?|dollars?|pounds?)\b/i,
];

const FEE_RE =
  /\b(ticket price|tickets? (?:from|cost|available)|registration fee|entry fee|early bird|paid (?:event|workshop|training|session)|per (?:person|seat|attendee)|course fee|admission fee)\b/i;

function textOf(e: EventItem): string {
  return `${e.name} ${e.location} ${e.tags.join(" ")} ${e.description ?? ""}`;
}

function looksVirtual(e: EventItem): boolean {
  return VIRTUAL_RE.test(e.name) || VIRTUAL_DESC_RE.test(e.description ?? "");
}

function isPaid(e: EventItem): boolean {
  const text = textOf(e);
  if (FEE_RE.test(text)) return true;
  // A bare amount only counts when the listing doesn't also say it's free
  // ("free entry, drinks €5" is a normal meetup, not a paid training).
  if (FREE_RE.test(text)) return false;
  return PRICE_RES.some((re) => re.test(text));
}

/**
 * Is this an online session advertised under a physical location? The misleading
 * case the user hits: a webinar listed under "Berlin" because it was posted to a
 * Berlin group. An honestly-labelled "Online" event is not flagged.
 */
function isVirtualInCity(e: EventItem): boolean {
  if (!looksVirtual(e)) return false;
  const loc = e.location.trim();
  if (!loc) return false;
  return !VIRTUAL_RE.test(loc);
}

interface Group {
  idxs: number[];
  sources: Set<string>;
  organizers: Set<string>;
  locations: Set<string>;
}

function groupBy(events: EventItem[], key: (e: EventItem) => string | null): Map<string, Group> {
  const groups = new Map<string, Group>();
  events.forEach((e, idx) => {
    const k = key(e);
    if (k === null) return;
    let g = groups.get(k);
    if (!g) {
      g = { idxs: [], sources: new Set(), organizers: new Set(), locations: new Set() };
      groups.set(k, g);
    }
    g.idxs.push(idx);
    g.sources.add(e.source);
    g.locations.add(norm(e.location));
    if (e.organizer) g.organizers.add(norm(e.organizer));
  });
  return groups;
}

/**
 * Cross-posting signals, which need the whole merged event set to see at all.
 *  - same title + same date in ≥ CROSSPOST_MIN calendars, spanning more than one
 *    location → `cross_posted`
 *  - same title in ≥ CROSSPOST_MIN calendars by one organizer, or looking
 *    virtual, but on different dates → `cross_posted_series` (weak)
 *
 * The multiple-locations requirement is what separates spam from a real local
 * meetup that several aggregator calendars happen to list: the junk is the same
 * session sold into Dublin, Barcelona, Milan and Amsterdam at once, while the
 * genuine article stays in one city no matter how many calendars carry it.
 */
function crossPostSignals(events: EventItem[]): Map<number, Signal[]> {
  const out = new Map<number, Signal[]>();
  const add = (idx: number, signal: Signal) => {
    const list = out.get(idx) ?? [];
    if (!list.includes(signal)) list.push(signal);
    out.set(idx, list);
  };

  const sameDay = groupBy(events, (e) => {
    const title = norm(e.name);
    if (!isDistinctiveTitle(title)) return null;
    return `${title}|${e.dates[0] ?? "?"}`;
  });
  for (const g of sameDay.values()) {
    if (g.sources.size >= CROSSPOST_MIN && g.locations.size > 1) {
      for (const idx of g.idxs) add(idx, "cross_posted");
    }
  }

  const sameTitle = groupBy(events, (e) => {
    const title = norm(e.name);
    return isDistinctiveTitle(title) ? title : null;
  });
  for (const g of sameTitle.values()) {
    if (g.sources.size < CROSSPOST_MIN) continue;
    const oneOrganizer = g.organizers.size === 1;
    const virtual = g.idxs.some((idx) => looksVirtual(events[idx]));
    if (oneOrganizer || virtual) for (const idx of g.idxs) add(idx, "cross_posted_series");
  }

  return out;
}

// --- Duplicate collapsing --------------------------------------------------

/** A URL that just points back at a calendar feed is a poor link for a human. */
function isFeedUrl(url: string): boolean {
  return /\.ics(\?|$)|\/events\/ical\/?$|api\.lu\.ma\/ics\//i.test(url);
}

/** Prefer the copy of an event that links somewhere a person can actually read. */
function linkQuality(e: EventItem): number {
  if (!e.url) return 0;
  return isFeedUrl(e.url) ? 1 : 2;
}

/**
 * Keys that identify "the same real event". Same title on the same day at the
 * same place, or same title on the same day from the same organizer — either way
 * two calendars are describing one thing.
 */
function dedupeKeys(e: EventItem): string[] {
  const title = norm(e.name);
  if (!title) return [];
  const day = e.dates[0] ?? "?";
  const loc = norm(e.location);
  const org = norm(e.organizer ?? "");
  const keys: string[] = [];
  // A generic title ("monthly meetup") is only safe to collapse when the place
  // matches too — otherwise four cities' meetups would merge into one.
  if (loc || isDistinctiveTitle(title)) keys.push(`${title}|${day}|loc:${loc}`);
  if (org) keys.push(`${title}|${day}|org:${org}`);
  return keys;
}

/**
 * Collapse repeats of the same event across overlapping calendars, keeping the
 * copy with the most useful link. Returns the deduplicated list and how many
 * copies were folded away.
 */
export function dedupeEvents(events: EventItem[]): { events: EventItem[]; collapsed: number } {
  const kept: EventItem[] = [];
  const slotOf = new Map<string, number>();
  let collapsed = 0;

  for (const e of events) {
    const keys = dedupeKeys(e);
    let slot = -1;
    for (const k of keys) {
      const found = slotOf.get(k);
      if (found !== undefined) {
        slot = found;
        break;
      }
    }
    if (slot === -1) {
      kept.push(e);
      for (const k of keys) slotOf.set(k, kept.length - 1);
      continue;
    }
    collapsed++;
    if (linkQuality(e) > linkQuality(kept[slot])) kept[slot] = e;
    // Register this copy's keys too, so a third listing that matches only by
    // organizer (or only by venue) still lands in the same slot.
    for (const k of keys) if (!slotOf.has(k)) slotOf.set(k, slot);
  }

  return { events: kept, collapsed };
}

export interface SpamVerdict {
  spam: boolean;
  score: number;
  signals: Signal[];
  /** Human-readable explanation, for the ops report and for the agent to quote. */
  reason: string;
  /** Set when a stored rule decided this (block or allow). */
  ruleId?: string;
}

function describe(signals: Signal[], ruleId?: string): string {
  if (ruleId) return `blocked by rule ${ruleId}`;
  if (signals.length === 0) return "";
  return signals.map((s) => SIGNAL_LABELS[s]).join(" + ");
}

/**
 * Classify every event in one pass. Returns a verdict per array index (not per
 * id — two feeds can carry the same listing, and each copy gets its own verdict).
 */
export async function classifyEvents(events: EventItem[]): Promise<SpamVerdict[]> {
  const rules = await listRules();
  const crossPost = crossPostSignals(events);

  return events.map((e, idx) => {
    const values = matchValues(e);
    const matched = rules.filter((r) => ruleMatches(r, values));
    // An explicit allow always wins: it's how a false positive gets pinned back
    // into view, and it must beat both heuristics and a broader block rule.
    const allow = matched.find((r) => r.kind === "allow");
    if (allow) return { spam: false, score: 0, signals: [], reason: `allowed by rule ${allow.id}`, ruleId: allow.id };
    const block = matched.find((r) => r.kind === "block");
    if (block) {
      return { spam: true, score: THRESHOLD, signals: [], reason: describe([], block.id), ruleId: block.id };
    }

    const signals: Signal[] = [...(crossPost.get(idx) ?? [])];
    if (isVirtualInCity(e)) signals.push("virtual_in_city");
    if (isPaid(e)) signals.push("paid");
    if (PROMO_RE.test(textOf(e))) signals.push("promo");

    const score = signals.reduce((sum, s) => sum + WEIGHTS[s], 0);
    return { spam: score >= THRESHOLD, score, signals, reason: describe(signals) };
  });
}

export interface DroppedEvent {
  id: string;
  name: string;
  source: string;
  date: string | null;
  location: string;
  url: string;
  score: number;
  signals: Signal[];
  reason: string;
  ruleId?: string;
}

export function toDropped(e: EventItem, v: SpamVerdict): DroppedEvent {
  return {
    id: eventId(e),
    name: e.name,
    source: e.source,
    date: e.dates[0] ?? null,
    location: e.location,
    url: e.url,
    score: v.score,
    signals: v.signals,
    reason: v.reason,
    ...(v.ruleId ? { ruleId: v.ruleId } : {}),
  };
}

/** Tally dropped events per signal (rule-based drops counted under `rules`). */
export function countBySignal(dropped: DroppedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of dropped) {
    if (d.ruleId) counts.rules = (counts.rules ?? 0) + 1;
    for (const s of d.signals) counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

export function summarizeDropped(dropped: DroppedEvent[]): string {
  const counts = countBySignal(dropped);
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([signal, n]) => `${SIGNAL_LABELS[signal as Signal] ?? signal} ${n}`);
  return parts.join(" · ");
}

// --- Report (what the last full scan filtered, for review) -----------------

export interface SpamReport {
  at: number;
  total: number;
  counts: Record<string, number>;
  /** Capped sample of the dropped listings, most-recently-scanned first. */
  sample: DroppedEvent[];
}

const REPORT_SAMPLE = 50;

export async function saveSpamReport(dropped: DroppedEvent[], now: number): Promise<SpamReport> {
  const report: SpamReport = {
    at: now,
    total: dropped.length,
    counts: countBySignal(dropped),
    sample: dropped.slice(0, REPORT_SAMPLE),
  };
  await store.write(REPORT_KEY, report);
  return report;
}

export async function getSpamReport(): Promise<SpamReport | null> {
  return store.read<SpamReport | null>(REPORT_KEY, null);
}
