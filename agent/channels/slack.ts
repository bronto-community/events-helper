import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

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
});
