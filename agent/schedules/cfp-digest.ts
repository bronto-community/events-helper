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
          "overlay). Then call list_cfps focused on those keywords/locations with withinDays=60. Post a " +
          "short, scannable digest of the matching upcoming CfPs — each line: deadline (and days left), " +
          "event name, location, and the submission link, sorted by soonest deadline. If nothing " +
          "matches, finish without posting anything.",
        target: { channelId: CHANNEL_ID },
        auth: appAuth,
      }),
    );
  },
});
