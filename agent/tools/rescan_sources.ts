import { defineTool } from "eve/tools";
import { z } from "zod";
import { runSourceScan } from "../lib/scan.js";
import { postToChannel } from "../lib/slack-notify.js";

export default defineTool({
  description:
    "Rescan all event/CfP sources now: fetch everything upcoming, compare to the last scan, and post " +
    "a summary (totals + what's new) to the ops channel — same as the scheduled scan. Use when the " +
    "user asks to rescan/refresh the sources or check for newly added CfPs/events. Returns the summary.",
  inputSchema: z.object({}),
  async execute() {
    const result = await runSourceScan(Date.now());
    const channel = process.env.EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL;
    let postedToOps = false;
    let postError: string | undefined;
    if (channel) {
      const posted = await postToChannel(channel, result.message);
      postedToOps = posted.ok;
      postError = posted.error;
    } else {
      postError = "EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL not set";
    }
    return {
      cfpTotal: result.cfpTotal,
      eventTotal: result.eventTotal,
      ocgroupsCount: result.ocgroupsCount,
      sourceCount: result.sourceCount,
      newCfps: result.newCfps.length,
      newEvents: result.newEvents.length,
      firstScan: result.firstScan,
      postedToOps,
      postError,
      summary: result.message,
    };
  },
});
