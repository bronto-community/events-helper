import { defineSchedule } from "eve/schedules";

import {
  ALERTS_ENABLED,
  cfpId,
  computeUserAlerts,
  computeUserEventAlerts,
  eventId,
  listSubscribers,
  recordAlerted,
  recordEventAlerted,
} from "../lib/alerts.js";
import { cfpAlertBlocks, eventAlertBlocks } from "../lib/cards.js";
import { postBlocks, postToChannel } from "../lib/slack-notify.js";
import { errorAttributes, log } from "../lib/log.js";
import type { Cfp, EventItem } from "../lib/types.js";

// Daily per-user alerts (06:30 UTC). For each SUBSCRIBED user, DM the CfPs
// matching their interests that are newly matched or newly closing-soon, plus
// newly-announced events matching their interests (e.g. from watched Meetup
// groups), as interactive cards. Best-effort per user; one failure doesn't stop
// the rest.
const MAX_PER_USER = 10;

/** The raw Slack user id (Uxxxx) from a `slack:<team>:<Uxxxx>` principal. */
function slackUserId(principalId: string): string | null {
  const last = principalId.split(":").pop() ?? "";
  return last.startsWith("U") ? last : null;
}

export default defineSchedule({
  cron: "30 6 * * *",
  async run({ waitUntil }) {
    if (!ALERTS_ENABLED) return;
    waitUntil(
      (async () => {
        const now = Date.now();
        const subscribers = await listSubscribers();
        log.info("cfp-alerts run", {
          "events_helper.alerts.subscriber_count": subscribers.length,
        });

        for (const principalId of subscribers) {
          try {
            const uid = slackUserId(principalId);
            if (!uid) continue;

            const { fresh, closingSoon } = await computeUserAlerts(principalId, now);
            const eventAlerts = await computeUserEventAlerts(principalId, now);

            // First event-alert run for this user: record the current matches as a
            // baseline and send nothing for events, so they only ever get events
            // announced AFTER they subscribed (never a backlog flood).
            if (eventAlerts.baseline) {
              await recordEventAlerted(principalId, eventAlerts.currentIds, now);
            }

            // CfPs first (deadline-driven), then new events, under a shared cap.
            const cfpItems: { cfp: Cfp; reminder: boolean }[] = [
              ...fresh.map((cfp) => ({ cfp, reminder: false })),
              ...closingSoon.map((cfp) => ({ cfp, reminder: true })),
            ];
            const sendCfps = cfpItems.slice(0, MAX_PER_USER);
            const eventBudget = Math.max(0, MAX_PER_USER - sendCfps.length);
            const sendEvents: EventItem[] = eventAlerts.fresh.slice(0, eventBudget);
            if (sendCfps.length === 0 && sendEvents.length === 0) continue;

            const cfpTotal = fresh.length + closingSoon.length;
            const parts: string[] = [];
            if (sendCfps.length)
              parts.push(`${sendCfps.length}${cfpTotal > sendCfps.length ? ` of ${cfpTotal}` : ""} CfP${sendCfps.length === 1 ? "" : "s"}`);
            if (sendEvents.length)
              parts.push(`${sendEvents.length}${eventAlerts.fresh.length > sendEvents.length ? ` of ${eventAlerts.fresh.length}` : ""} new event${sendEvents.length === 1 ? "" : "s"}`);
            await postToChannel(
              uid,
              `📣 *${parts.join(" + ")} for you* (matched to your interests). Use the buttons, or reply here to file a CfP to Jira.`,
            );
            for (const it of sendCfps) {
              const { blocks, fallbackText } = cfpAlertBlocks(it.cfp, { reminder: it.reminder });
              await postBlocks(uid, blocks, fallbackText);
            }
            for (const ev of sendEvents) {
              const { blocks, fallbackText } = eventAlertBlocks(ev);
              await postBlocks(uid, blocks, fallbackText);
            }

            // Only record what we actually sent, so capped items resurface next run.
            await recordAlerted(
              principalId,
              {
                freshIds: sendCfps.filter((i) => !i.reminder).map((i) => cfpId(i.cfp)),
                soonIds: sendCfps.filter((i) => i.reminder).map((i) => cfpId(i.cfp)),
              },
              now,
            );
            if (sendEvents.length) {
              await recordEventAlerted(principalId, sendEvents.map(eventId), now);
            }
            log.info("alerts sent", {
              "user.id": principalId,
              "events_helper.alerts.fresh_count": fresh.length,
              "events_helper.alerts.closing_soon_count": closingSoon.length,
              "events_helper.alerts.event_fresh_count": eventAlerts.fresh.length,
              "events_helper.alerts.event_baseline": eventAlerts.baseline,
              "events_helper.alerts.sent_count": sendCfps.length + sendEvents.length,
            });
          } catch (err) {
            log.warn("alerts user failed", { "user.id": principalId, ...errorAttributes(err) });
          }
        }
      })(),
    );
  },
});
