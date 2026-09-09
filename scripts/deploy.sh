#!/usr/bin/env sh
# Deploy events-helper to Vercel production by hand.
#
# This is the escape hatch, not the normal path. Merging a PR is what deploys:
# Vercel's Git integration builds and promotes `main` on its own.
#
# Either way the operator gets the Slack notice and the Bronto deployment event,
# because those are sent by the agent when Vercel's `deployment.succeeded` webhook
# arrives (agent/channels/vercel-deploy.ts), not from this script. That is why a
# hand deploy, a merge, and a dashboard rollback all announce themselves
# identically, and why this script needs no Slack credentials.
#
# The commit is still injected as a runtime env var so a deploy from a dirty or
# detached tree reports the sha it actually built (see agent/lib/deploy.ts).

set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

HEAD_FULL=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠ working tree has uncommitted changes — deploying as-is."
fi

echo "▶ deploying to production…"
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod -e "EVENTS_HELPER_COMMIT=$HEAD_FULL"
echo "✓ deployed. Slack notice follows from the deployment.succeeded webhook."
