import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { SNOOZE_DAYS, markDismissed, markSnoozed } from "../lib/alerts.js";
import { decodeCfpRef, resolvedBlocks } from "../lib/cards.js";
import { log } from "../lib/log.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Slack is wired through Vercel Connect — no SLACK_BOT_TOKEN / signing secret to
// manage. Connector UID "slack/bronto-events-helper" (scl_qsSUXvAHPV70uOMyNOAg).
//
// IMPORTANT: `vercel connect create slack --triggers` points the trigger at the
// DEFAULT Connect path, which eve does not serve. Re-point it at eve's Slack
// route before Slack events will arrive:
//
//   vercel connect detach slack/bronto-events-helper --yes
//   vercel connect attach slack/bronto-events-helper --triggers --trigger-path /eve/v1/slack --yes
//
// `eve dev` does not need Slack configured; this channel activates after deploy.
export default slackChannel({
  credentials: connectSlackCredentials("slack/bronto-events-helper"),
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
        log.warn("cfp interaction without teamId", { actionId: action.actionId });
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
      log.info("cfp interaction", { actionId: action.actionId, user: principalId, cfp: ref.i });

      if (action.messageTs) {
        await ctx.slack.request("chat.update", {
          channel: ctx.slack.channelId,
          ts: action.messageTs,
          text: status,
          blocks: resolvedBlocks(ref.n, status),
        });
      }
    } catch (err) {
      log.warn("onInteraction failed", { error: String(err) });
    }
  },
});
