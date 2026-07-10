#!/usr/bin/env sh
# Deploy events-helper to Vercel production, then notify the operator on Slack
# with a summary of the changes since the last deploy.
#
# Config (env or .env.local):
#   EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL  Slack channel id (Cxxxx) or the operator's
#                                        user id (Uxxxx) to DM. If unset, notify is skipped.
#   SLACK_CONNECTOR                      Vercel Connect Slack connector uid
#                                        (default: slack/bronto-events-helper)
#
# The bot token is fetched at runtime via Vercel Connect and is never printed.

set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# Export .env.local so child processes (the notifier) see VERCEL_OIDC_TOKEN etc.
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi

NOTIFY="${EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL:-}"

# --- build the change summary from git --------------------------------------
HEAD_SHORT=$(git rev-parse --short HEAD)
HEAD_FULL=$(git rev-parse HEAD)
PREV=$(cat .last-deploy-sha 2>/dev/null || true)
if [ -n "$PREV" ] && git cat-file -e "${PREV}^{commit}" 2>/dev/null && [ "$PREV" != "$HEAD_FULL" ]; then
  CHANGES=$(git log --no-merges --pretty='• %s (%h)' "${PREV}..HEAD")
  STAT=$(git diff --shortstat "$PREV" HEAD)
else
  CHANGES=$(git log --no-merges -1 --pretty='• %s (%h)')
  STAT="(no previous deploy recorded — showing latest commit)"
fi
DIRTY=""
[ -n "$(git status --porcelain)" ] && DIRTY="⚠ working tree had uncommitted changes (deployed as-is)"

# --- deploy -----------------------------------------------------------------
# Inject the exact commit as a runtime env var so traces + logs carry the same
# `vcs.ref.head.revision` as this deployment log (see agent/lib/deploy.ts).
echo "▶ deploying to production…"
set +e
OUT=$(VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod -e "EVENTS_HELPER_COMMIT=$HEAD_FULL" 2>&1)
CODE=$?
set -e
printf '%s\n' "$OUT" | tail -3
if [ "$CODE" -ne 0 ]; then
  echo "❌ deploy failed (exit $CODE) — not notifying."
  exit "$CODE"
fi
URL=$(printf '%s\n' "$OUT" | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | tail -1)
DEPLOY_ID=$(printf '%s\n' "$OUT" | grep -oE 'dpl_[A-Za-z0-9]+' | head -1)

# record what we just deployed so the next run can diff against it
printf '%s\n' "$HEAD_FULL" > .last-deploy-sha

# --- notify the operator ----------------------------------------------------
# The Slack app token can only be minted by the project runtime/OIDC (not the
# CLI user), so notify-deploy.mjs uses the @vercel/connect SDK with the OIDC
# token from the environment. Best-effort: if the OIDC token is missing/expired
# (refresh with `vercel env pull`), the deploy still succeeds and this is skipped.
DEPLOY_TEXT=$(printf '🚀 *events-helper redeployed to production*\nCommit %s — %s\n\n*Changes since last deploy:*\n%s\n\n_%s_%s' \
  "$HEAD_SHORT" "${URL:-(url unknown)}" "$CHANGES" "$STAT" \
  "$( [ -n "$DIRTY" ] && printf '\n%s' "$DIRTY" )")

echo "▶ notifying operator on Slack…"
DEPLOY_TEXT="$DEPLOY_TEXT" DEPLOY_COMMIT="$HEAD_FULL" DEPLOY_ID="${DEPLOY_ID:-}" DEPLOY_URL="${URL:-}" \
  node scripts/notify-deploy.mjs
