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

// Also emit a deployment log to Bronto (OTLP/HTTP JSON → /v1/logs) so there's a
// durable "deployed" event next to the traces. Best-effort.
await postBrontoDeployLog();

async function postBrontoDeployLog() {
  const endpoint = process.env.BRONTO_OTLP_ENDPOINT?.replace(/\/$/, "");
  const apiKey = process.env.BRONTO_API_KEY;
  if (!endpoint || !apiKey) return;
  // OTel semconv keys so this deployment log correlates with traces + app logs
  // (which carry the same vcs.ref.head.revision / deployment.id).
  const attrs = [
    { key: "event.name", value: { stringValue: "deployment" } },
    { key: "service.name", value: { stringValue: "events-helper" } },
    { key: "deployment.environment.name", value: { stringValue: "production" } },
  ];
  if (process.env.DEPLOY_COMMIT)
    attrs.push({ key: "vcs.ref.head.revision", value: { stringValue: process.env.DEPLOY_COMMIT } });
  if (process.env.DEPLOY_ID)
    attrs.push({ key: "deployment.id", value: { stringValue: process.env.DEPLOY_ID } });
  if (process.env.DEPLOY_URL)
    attrs.push({ key: "url.full", value: { stringValue: process.env.DEPLOY_URL } });
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "events-helper" } }] },
        scopeLogs: [
          {
            scope: { name: "events-helper.deploy" },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: text.replace(/\*/g, "") },
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  };
  const headers = {
    "Content-Type": "application/json",
    "x-bronto-api-key": apiKey,
    // Deployment events go to their own dataset, separate from traces + runtime logs.
    "x-bronto-dataset": process.env.BRONTO_DEPLOY_DATASET || "agent-deployments",
  };
  if (process.env.BRONTO_COLLECTION) headers["x-bronto-collection"] = process.env.BRONTO_COLLECTION;
  try {
    const r = await fetch(`${endpoint}/v1/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    console.log(r.ok ? "✓ deployment log sent to Bronto" : `⚠ Bronto log HTTP ${r.status}`);
  } catch (e) {
    console.log(`⚠ Bronto log failed: ${e?.message ?? e}`);
  }
}
