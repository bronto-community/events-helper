import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack.js";

// Weekly CfP digest into Slack. Fires Mondays at 08:00 UTC (Vercel evaluates
// cron in UTC). Set SLACK_DIGEST_CHANNEL_ID to the target channel; if it's
// unset the schedule no-ops so the agent never posts into the void.
const CHANNEL_ID = process.env.SLACK_DIGEST_CHANNEL_ID;

export default defineSchedule({
  cron: "0 8 * * 1",
  async run({ receive, waitUntil, appAuth }) {
    if (!CHANNEL_ID) return;
    waitUntil(
      receive(slack, {
        message:
          "Produce this week's CfP digest for the whole team. Call manage_interests action get and use " +
          "the GLOBAL profile's keywords/locations (this runs as the app, so there is no personal " +
          "overlay). Then call list_cfps focused on those keywords/locations with withinDays=60. " +
          "Your reply IS the Slack message — the channel posts whatever you finish with, verbatim — so " +
          "reply with the digest itself and nothing else: no preamble, no sign-off, and no remark about " +
          "whether it was posted. Keep it short and scannable, one line per CfP: deadline (printed from " +
          "deadlineLabel, so it carries the weekday) and days left, event name, location, and the " +
          "submission link, sorted by soonest deadline. If you mention when an event runs, print " +
          "eventDatesLabel for the same reason. If nothing " +
          "matches, finish the turn without sending a message so the channel stays quiet.",
        target: { channelId: CHANNEL_ID },
        auth: appAuth,
      }),
    );
  },
});
