import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { SNOOZE_DAYS, markDismissed, markEventDismissed, markSnoozed } from "../lib/alerts.js";
import { decodeCfpRef, resolvedBlocks } from "../lib/cards.js";
import { errorAttributes, log } from "../lib/log.js";
import { isAdmin } from "../lib/roles.js";
import { addRules, rulesFromIdAndTitle } from "../lib/spam.js";

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
      const handled = ["cfp_dismiss", "cfp_snooze", "event_dismiss", "event_snooze", "event_spam"];
      if (!handled.includes(action.actionId)) return;
      const teamId = ctx.slack.teamId;
      if (!teamId) {
        log.warn("alert interaction without teamId", {
          "events_helper.slack.action_id": action.actionId,
        });
        return;
      }
      const principalId = `slack:${teamId}:${action.user.id}`;
      const ref = decodeCfpRef(action.value);
      if (!ref) return;
      const noun = action.actionId.startsWith("event_") ? "event" : "CfP";

      let status: string;
      if (action.actionId === "cfp_dismiss") {
        await markDismissed(principalId, ref.i);
        status = "🔕 Not interested — you won't be alerted about this CfP again.";
      } else if (action.actionId === "event_dismiss") {
        await markEventDismissed(principalId, ref.i);
        status = "🔕 Not interested — you won't be alerted about this event again.";
      } else if (action.actionId === "event_spam") {
        // Spam is a team-wide verdict, so only admins get to make it. For everyone
        // else the click still does the useful thing: mute it for them.
        if (isAdmin(principalId)) {
          const { added } = await addRules(
            rulesFromIdAndTitle(ref.i, ref.n, "flagged as spam from a Slack alert card"),
            principalId,
            Date.now(),
          );
          const byTitle = added.some((r) => r.match === "title");
          status = `🚫 Marked as spam — filtered out for the whole team from now on${
            byTitle ? ", including re-posts of the same title" : ""
          }.`;
        } else {
          await markEventDismissed(principalId, ref.i);
          status =
            "🔕 Muted for you. Marking something as team-wide spam needs an admin — ask one to run “block this as spam”.";
        }
      } else {
        await markSnoozed(principalId, ref.i, Date.now() + SNOOZE_DAYS * DAY_MS);
        status = `😴 Snoozed for ${SNOOZE_DAYS} days.`;
      }
      log.info("alert interaction", {
        "events_helper.slack.action_id": action.actionId,
        "user.id": principalId,
        "events_helper.alert.kind": noun,
        "events_helper.alert.id": ref.i,
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
