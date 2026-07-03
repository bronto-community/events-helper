// Post a deploy summary to Slack using the bot's Connect app token.
// Uses the @vercel/connect SDK (OIDC-authenticated, like the runtime) rather
// than the CLI, which cannot mint app-subject tokens. Never prints the token.
//
// Env: SLACK_CONNECTOR, EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL, DEPLOY_TEXT,
//      VERCEL_OIDC_TOKEN (from `vercel env pull` / .env.local).
import { getToken } from "@vercel/connect";

const connector = process.env.SLACK_CONNECTOR || "slack/bronto-events-helper";
const channel = process.env.EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL;
const text = process.env.DEPLOY_TEXT || "events-helper redeployed.";

if (!channel) {
  console.log("ℹ EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL not set — skipping notification.");
  process.exit(0);
}

let token;
try {
  token = await getToken(connector, { subject: { type: "app" } });
} catch (e) {
  console.log(`⚠ could not obtain Slack app token: ${e?.message ?? e}`);
  process.exit(0);
}

const res = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ channel, text }),
});
const body = await res.json();
console.log(body.ok ? "✓ operator notified in Slack" : `⚠ Slack error: ${body.error}`);
