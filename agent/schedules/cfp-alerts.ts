import { defineSchedule } from "eve/schedules";

import { ALERTS_ENABLED, cfpId, computeUserAlerts, listSubscribers, recordAlerted } from "../lib/alerts.js";
import { cfpAlertBlocks } from "../lib/cards.js";
import { postBlocks, postToChannel } from "../lib/slack-notify.js";
import { log } from "../lib/log.js";
import type { Cfp } from "../lib/types.js";

// Daily per-user CfP alerts (06:30 UTC). For each SUBSCRIBED user, DM the CfPs
// matching their interests that are newly matched or newly closing-soon, as
// interactive cards. Best-effort per user; one failure doesn't stop the rest.
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
        log.info("cfp-alerts run", { subscribers: subscribers.length });

        for (const principalId of subscribers) {
          try {
            const uid = slackUserId(principalId);
            if (!uid) continue;

            const { fresh, closingSoon } = await computeUserAlerts(principalId, now);
            const items: { cfp: Cfp; reminder: boolean }[] = [
              ...fresh.map((cfp) => ({ cfp, reminder: false })),
              ...closingSoon.map((cfp) => ({ cfp, reminder: true })),
            ].slice(0, MAX_PER_USER);
            if (items.length === 0) continue;

            const total = fresh.length + closingSoon.length;
            const more = total > items.length ? ` of ${total}` : "";
            await postToChannel(
              uid,
              `📣 *${items.length}${more} CfP${items.length === 1 ? "" : "s"} for you* (matched to your interests). Use the buttons, or reply here to file one to Jira.`,
            );
            for (const it of items) {
              const { blocks, fallbackText } = cfpAlertBlocks(it.cfp, { reminder: it.reminder });
              await postBlocks(uid, blocks, fallbackText);
            }

            // Only record what we actually sent, so capped items resurface next run.
            await recordAlerted(
              principalId,
              {
                freshIds: items.filter((i) => !i.reminder).map((i) => cfpId(i.cfp)),
                soonIds: items.filter((i) => i.reminder).map((i) => cfpId(i.cfp)),
              },
              now,
            );
            log.info("cfp-alerts sent", {
              user: principalId,
              fresh: fresh.length,
              soon: closingSoon.length,
              sent: items.length,
            });
          } catch (err) {
            log.warn("cfp-alerts user failed", { user: principalId, error: String(err) });
          }
        }
      })(),
    );
  },
});
