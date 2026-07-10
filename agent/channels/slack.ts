import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { SNOOZE_DAYS, markDismissed, markSnoozed } from "../lib/alerts.js";
import { decodeCfpRef, resolvedBlocks } from "../lib/cards.js";
import { errorAttributes, log } from "../lib/log.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Slack is wired through Vercel Connect — no SLACK_BOT_TOKEN / signing secret to
// manage. Set SLACK_CONNECTOR to your Vercel Connect Slack connector UID.
//
// IMPORTANT: `vercel connect create slack --triggers` points the trigger at the
// DEFAULT Connect path, which eve does not serve. Re-point it at eve's Slack
// route before Slack events will arrive:
//
//   vercel connect detach <uid> --yes
//   vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
//
// `eve dev` does not need Slack configured; this channel activates after deploy.
const SLACK_CONNECTOR = process.env.SLACK_CONNECTOR || "slack/bronto-events-helper";

export default slackChannel({
  credentials: connectSlackCredentials(SLACK_CONNECTOR),
  // Fetch just the new replies in a thread on each mention, so follow-up
  // questions see context without re-reading the whole thread.
  threadContext: { since: "last-agent-reply" },
  // Handle the CfP alert-card buttons (non-HITL block_actions). Side-effects
  // only — a button can't start an agent turn, so "file to Jira" is done by
  // replying to the DM instead.
  async onInteraction(action, ctx) {
    try {
      if (action.actionId !== "cfp_dismiss" && action.actionId !== "cfp_snooze") return;
      const teamId = ctx.slack.teamId;
      if (!teamId) {
        log.warn("cfp interaction without teamId", {
          "events_helper.slack.action_id": action.actionId,
        });
        return;
      }
      const principalId = `slack:${teamId}:${action.user.id}`;
      const ref = decodeCfpRef(action.value);
      if (!ref) return;

      let status: string;
      if (action.actionId === "cfp_dismiss") {
        await markDismissed(principalId, ref.i);
        status = "🔕 Not interested — you won't be alerted about this CfP again.";
      } else {
        await markSnoozed(principalId, ref.i, Date.now() + SNOOZE_DAYS * DAY_MS);
        status = `😴 Snoozed for ${SNOOZE_DAYS} days.`;
      }
      log.info("cfp interaction", {
        "events_helper.slack.action_id": action.actionId,
        "user.id": principalId,
        "events_helper.cfp.id": ref.i,
      });

      if (action.messageTs) {
        await ctx.slack.request("chat.update", {
          channel: ctx.slack.channelId,
          ts: action.messageTs,
          text: status,
          blocks: resolvedBlocks(ref.n, status),
        });
      }
    } catch (err) {
      log.warn("onInteraction failed", errorAttributes(err));
    }
  },
});
