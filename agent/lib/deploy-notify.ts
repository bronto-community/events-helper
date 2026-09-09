import { errorAttributes, log } from "./log.js";
import { postToChannel } from "./slack-notify.js";
import { read, write } from "./store.js";

// Operator notification for a production deployment, driven by Vercel's
// `deployment.succeeded` webhook (see agent/channels/vercel-deploy.ts) instead of
// by the deploy script.
//
// Doing it here rather than in CI is what makes it reliable. Minting the Slack
// Connect app token needs a Vercel OIDC token: the runtime has one natively, while
// a laptop or a CI job only gets one from `vercel env pull`, and it expires — which
// is why the old script-based notice had to be best-effort. It also means every
// production deploy is announced, including a dashboard rollback or someone's CLI
// deploy, not just the ones that went through the wrapper.
//
// The Bronto deployment event goes to its own dataset (BRONTO_DEPLOY_DATASET),
// separate from traces + runtime logs, and carries the same OTel semconv keys
// (`vcs.ref.head.revision`, `deployment.id`) that lib/deploy.ts stamps on spans and
// app logs, so a deploy correlates with everything that ran on it.

const STATE_KEY = "events-helper/deploy/last-production.json";
const REPO_URL = (
  process.env.EVENTS_HELPER_REPO_URL || "https://github.com/bronto-community/events-helper"
).replace(/\/$/, "");

type DeployState = { deploymentId?: string; commit?: string };

export type DeploymentEvent = {
  deploymentId: string;
  /** Deployment hostname, without scheme, as Vercel reports it. */
  url?: string;
  commit?: string;
  branch?: string;
  commitMessage?: string;
  /** Dashboard link for the deployment. */
  inspectorUrl?: string;
};

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/** First line only — commit bodies are long and Slack shows them badly. */
function subject(message: string | undefined): string {
  const line = (message ?? "").split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "(no commit message)";
}

function buildText(ev: DeploymentEvent, previousCommit: string | undefined): string {
  const parts = [`*events-helper deployed to production*`, subject(ev.commitMessage)];
  const refs: string[] = [`\`${short(ev.commit)}\``];
  if (ev.branch) refs.push(`on \`${ev.branch}\``);
  if (previousCommit && ev.commit && previousCommit !== ev.commit) {
    refs.push(`<${REPO_URL}/compare/${previousCommit}...${ev.commit}|what changed>`);
  }
  if (ev.inspectorUrl) refs.push(`<${ev.inspectorUrl}|deployment>`);
  else if (ev.url) refs.push(`<https://${ev.url}|deployment>`);
  parts.push(refs.join(" · "));
  return parts.join("\n");
}

async function shipDeployLogToBronto(ev: DeploymentEvent, text: string): Promise<void> {
  const endpoint = process.env.BRONTO_OTLP_ENDPOINT?.replace(/\/$/, "");
  const apiKey = process.env.BRONTO_API_KEY;
  if (!endpoint || !apiKey) return;
  const attributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: "event.name", value: { stringValue: "deployment" } },
    { key: "service.name", value: { stringValue: "events-helper" } },
    { key: "deployment.environment.name", value: { stringValue: "production" } },
    { key: "deployment.id", value: { stringValue: ev.deploymentId } },
  ];
  if (ev.commit) attributes.push({ key: "vcs.ref.head.revision", value: { stringValue: ev.commit } });
  if (ev.branch) attributes.push({ key: "vcs.ref.head.name", value: { stringValue: ev.branch } });
  if (ev.url) attributes.push({ key: "url.full", value: { stringValue: `https://${ev.url}` } });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-bronto-api-key": apiKey,
    "x-bronto-dataset": process.env.BRONTO_DEPLOY_DATASET || "agent-deployments",
  };
  if (process.env.BRONTO_COLLECTION) headers["x-bronto-collection"] = process.env.BRONTO_COLLECTION;
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "events-helper" } }],
        },
        scopeLogs: [
          {
            scope: { name: "events-helper.deploy" },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: text.replace(/[*`<>]/g, "") },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
  try {
    const res = await fetch(`${endpoint}/v1/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn("bronto deployment log rejected", {
        "http.response.status_code": res.status,
        "deployment.id": ev.deploymentId,
      });
    }
  } catch (err) {
    log.warn("bronto deployment log failed", {
      ...errorAttributes(err),
      "deployment.id": ev.deploymentId,
    });
  }
}

/**
 * Announce a successful production deployment: Slack notice to the operator
 * channel plus a Bronto deployment event. Idempotent per deployment id, so a
 * webhook redelivery does not double-post.
 */
export async function notifyProductionDeploy(
  ev: DeploymentEvent,
): Promise<{ notified: boolean; reason?: string }> {
  const previous = await read<DeployState>(STATE_KEY, {});
  if (previous.deploymentId === ev.deploymentId) {
    return { notified: false, reason: "already-notified" };
  }

  const text = buildText(ev, previous.commit);

  // Record before notifying: a redelivery of the same deployment should stay quiet
  // even if Slack is having a bad day. Losing one notice beats a duplicate storm.
  await write<DeployState>(STATE_KEY, {
    deploymentId: ev.deploymentId,
    commit: ev.commit ?? previous.commit,
  });

  await shipDeployLogToBronto(ev, text);

  const channel = process.env.EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL;
  if (!channel) return { notified: false, reason: "no-notify-channel" };

  const result = await postToChannel(channel, text);
  if (!result.ok) {
    log.warn("deploy notification failed", {
      "events_helper.error.detail": result.error ?? "unknown",
      "deployment.id": ev.deploymentId,
    });
    return { notified: false, reason: result.error ?? "slack-error" };
  }
  return { notified: true };
}
