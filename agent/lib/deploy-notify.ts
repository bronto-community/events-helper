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

/** Owner/repo path for the GitHub API, derived from the repo url. */
const REPO_SLUG = (() => {
  try {
    return new URL(REPO_URL).pathname.replace(/^\/|\/$/g, "");
  } catch {
    return "";
  }
})();

const MAX_BULLETS = 10;

type CompareSummary = { bullets: string[]; hiddenCount: number; stat: string };

/**
 * The commit list between two shas, from GitHub's compare API.
 *
 * The runtime has no git checkout, so this is how the notice gets an inline
 * "changes since last deploy" rather than only a link. Best-effort by design:
 * unauthenticated GitHub allows 60 requests an hour per IP, which deploy volume
 * never approaches, but a rate-limit or a slow response must never hold up (or
 * lose) a deploy notice — callers fall back to the bare compare link.
 */
async function fetchCompare(base: string, head: string): Promise<CompareSummary | null> {
  if (!REPO_SLUG) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/compare/${base}...${head}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "events-helper-deploy-notify",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn("github compare lookup failed", { "http.response.status_code": res.status });
      return null;
    }
    const body = (await res.json()) as {
      commits?: Array<{ sha?: string; parents?: unknown[]; commit?: { message?: string } }>;
      files?: Array<{ additions?: number; deletions?: number }>;
    };
    // Drop merge commits, matching what `git log --no-merges` used to show: the
    // merge of a PR restates its branch, so listing both is noise.
    const commits = (body.commits ?? []).filter((c) => (c.parents?.length ?? 1) <= 1);
    if (commits.length === 0) return null;
    const shown = commits.slice(-MAX_BULLETS).reverse();
    const bullets = shown.map((c) => `• ${subject(c.commit?.message)} (${short(c.sha)})`);
    const files = body.files ?? [];
    const additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
    const deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
    const stat = `${files.length} file${files.length === 1 ? "" : "s"} changed, ${additions} insertion${
      additions === 1 ? "" : "s"
    }(+), ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`;
    return { bullets, hiddenCount: Math.max(0, commits.length - shown.length), stat };
  } catch (err) {
    log.warn("github compare lookup threw", errorAttributes(err));
    return null;
  }
}

async function buildText(ev: DeploymentEvent, previousCommit: string | undefined): Promise<string> {
  const hasRange = Boolean(previousCommit && ev.commit && previousCommit !== ev.commit);
  const compare = hasRange ? await fetchCompare(previousCommit as string, ev.commit as string) : null;

  const parts = [`*events-helper deployed to production*`];
  const head = [`\`${short(ev.commit)}\``];
  if (ev.branch) head.push(`on \`${ev.branch}\``);
  parts.push(head.join(" "));

  if (compare) {
    parts.push("", "*Changes since last deploy:*", ...compare.bullets);
    if (compare.hiddenCount > 0) parts.push(`• …and ${compare.hiddenCount} more`);
    parts.push("", `_${compare.stat}_`);
  } else {
    // No baseline yet, or GitHub was unreachable: name the commit itself instead.
    parts.push(subject(ev.commitMessage));
  }

  const refs: string[] = [];
  if (hasRange) refs.push(`<${REPO_URL}/compare/${previousCommit}...${ev.commit}|what changed>`);
  if (ev.inspectorUrl) refs.push(`<${ev.inspectorUrl}|deployment>`);
  else if (ev.url) refs.push(`<https://${ev.url}|deployment>`);
  if (refs.length > 0) parts.push(refs.join(" · "));

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

  const text = await buildText(ev, previous.commit);

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
