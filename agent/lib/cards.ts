import { cfpId, eventId } from "./alerts.js";
import type { Cfp, EventItem } from "./types.js";

// Raw Slack Block Kit builders for CfP alert cards. We build blocks directly
// (rather than the JSX card DSL) for full control over button action_ids/values,
// which the Slack channel's onInteraction handler reads back.

type Block = Record<string, unknown>;

/** Button payload: the CfP id (for the ledger) + a short name (to re-render on click). */
export interface CfpRef {
  i: string;
  n: string;
}

export function encodeCfpRef(cfp: Cfp): string {
  const ref: CfpRef = { i: cfpId(cfp), n: cfp.event.slice(0, 120) };
  return JSON.stringify(ref);
}

export function encodeEventRef(e: EventItem): string {
  const ref: CfpRef = { i: eventId(e), n: e.name.slice(0, 120) };
  return JSON.stringify(ref);
}

export function decodeCfpRef(value: string | undefined): CfpRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CfpRef>;
    if (typeof parsed.i === "string") return { i: parsed.i, n: typeof parsed.n === "string" ? parsed.n : "" };
  } catch {
    // legacy / raw id
    return { i: value, n: "" };
  }
  return null;
}

function daysLeft(days: number | null): string {
  if (days === null) return "";
  if (days <= 0) return " (today)";
  return days === 1 ? " (1 day left)" : ` (${days} days left)`;
}

/** Interactive alert card for one CfP. `reminder` marks a closing-soon nudge. */
export function cfpAlertBlocks(cfp: Cfp, opts: { reminder?: boolean } = {}): {
  blocks: Block[];
  fallbackText: string;
} {
  const tag = opts.reminder ? "⏰ *Closing soon*" : "🆕 *New CfP*";
  const headline = `${tag} — *${cfp.event}*`;
  const meta = `📅 Deadline: *${cfp.deadline ?? "unknown"}*${daysLeft(cfp.daysUntilDeadline)}${
    cfp.location ? ` · 📍 ${cfp.location}` : ""
  }${cfp.eventDates[0] ? ` · event ${cfp.eventDates[0]}` : ""}`;
  const ref = encodeCfpRef(cfp);

  const elements: Block[] = [];
  if (cfp.cfpUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Submit ↗" },
      url: cfp.cfpUrl,
      action_id: "cfp_open",
      style: "primary",
    });
  }
  elements.push(
    { type: "button", text: { type: "plain_text", text: "Not interested" }, action_id: "cfp_dismiss", value: ref, style: "danger" },
    { type: "button", text: { type: "plain_text", text: "Snooze" }, action_id: "cfp_snooze", value: ref },
  );

  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${headline}\n${meta}` } },
      { type: "actions", elements },
    ],
    fallbackText: `${opts.reminder ? "Closing soon" : "New CfP"}: ${cfp.event} — deadline ${cfp.deadline ?? "unknown"}`,
  };
}

function startsIn(days: number | null): string {
  if (days === null) return "";
  if (days <= 0) return " (today)";
  return days === 1 ? " (in 1 day)" : ` (in ${days} days)`;
}

/** Interactive alert card for one newly-announced event (e.g. from a watched Meetup group). */
export function eventAlertBlocks(e: EventItem): { blocks: Block[]; fallbackText: string } {
  const headline = `🆕 *New event* — *${e.name}*`;
  const when = e.dates[0] ?? "date TBD";
  const meta = `📅 ${when}${startsIn(e.daysUntilStart)}${e.location ? ` · 📍 ${e.location}` : ""}${
    e.tags.length ? ` · ${e.tags.slice(0, 4).join(", ")}` : ""
  } · _${e.source}_`;
  const ref = encodeEventRef(e);

  const elements: Block[] = [];
  if (e.url) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "View ↗" },
      url: e.url,
      action_id: "event_open",
      style: "primary",
    });
  }
  elements.push(
    { type: "button", text: { type: "plain_text", text: "Not interested" }, action_id: "event_dismiss", value: ref, style: "danger" },
    { type: "button", text: { type: "plain_text", text: "Snooze" }, action_id: "event_snooze", value: ref },
  );

  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${headline}\n${meta}` } },
      { type: "actions", elements },
    ],
    fallbackText: `New event: ${e.name} — ${when}${e.location ? ` (${e.location})` : ""}`,
  };
}

/** Replacement blocks after a button resolves a card (dismiss/snooze). */
export function resolvedBlocks(name: string, statusLine: string): Block[] {
  const title = name ? `~${name}~` : "CfP";
  return [{ type: "section", text: { type: "mrkdwn", text: `${title}\n${statusLine}` } }];
}
