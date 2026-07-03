import { defineSchedule } from "eve/schedules";

import { runSourceScan } from "../lib/scan.js";
import { postToChannel } from "../lib/slack-notify.js";

// Daily source rescan (07:00 UTC). Scans every source, then posts a summary
// (totals + what's new since the last scan) to the ops channel. Gated on
// EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL (the same ops channel deploys post to).
const CHANNEL = process.env.EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL;

export default defineSchedule({
  cron: "0 7 * * *",
  async run({ waitUntil }) {
    if (!CHANNEL) return;
    waitUntil(
      (async () => {
        const result = await runSourceScan(Date.now());
        await postToChannel(CHANNEL, result.message);
      })(),
    );
  },
});
