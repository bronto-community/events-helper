// Deployment provenance for this running instance, stamped onto traces (OTel
// resource attributes) and every app log so they cross-correlate in Bronto with
// the deployment log — by commit (`vcs.ref.head.revision`) or Vercel deployment
// id (`deployment.id`). Attribute keys follow OpenTelemetry semantic conventions
// (VCS + deployment namespaces).
//
// The commit sha is injected by scripts/deploy.sh via
// `vercel deploy -e EVENTS_HELPER_COMMIT=<sha>` (so it matches the deploy log
// exactly); it falls back to Vercel's built-in git env for git-integration
// deploys. Deployment id, branch, and environment come from Vercel's runtime env.
// All values are empty in local dev, in which case the attribute is omitted.

const commit = process.env.EVENTS_HELPER_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "";
const branch = process.env.VERCEL_GIT_COMMIT_REF || "";
const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || "";
const environment = process.env.VERCEL_ENV || "";

/** Semconv attributes describing this deployment; empty values are omitted. */
export const DEPLOY_ATTRIBUTES: Record<string, string> = Object.fromEntries(
  Object.entries({
    "vcs.ref.head.revision": commit,
    "vcs.ref.head.name": branch,
    "deployment.id": deploymentId,
    "deployment.environment.name": environment,
  }).filter(([, v]) => v !== ""),
);

export const DEPLOY_COMMIT = commit;
