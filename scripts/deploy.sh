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
[ -f .env.local ] && . ./.env.local

CONNECTOR="${SLACK_CONNECTOR:-slack/bronto-events-helper}"
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
echo "▶ deploying to production…"
set +e
OUT=$(VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod 2>&1)
CODE=$?
set -e
printf '%s\n' "$OUT" | tail -3
if [ "$CODE" -ne 0 ]; then
  echo "❌ deploy failed (exit $CODE) — not notifying."
  exit "$CODE"
fi
URL=$(printf '%s\n' "$OUT" | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | tail -1)

# record what we just deployed so the next run can diff against it
printf '%s\n' "$HEAD_FULL" > .last-deploy-sha

# --- notify the operator ----------------------------------------------------
if [ -z "$NOTIFY" ]; then
  echo "ℹ EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL not set — skipping operator notification."
  exit 0
fi

echo "▶ notifying operator on Slack…"
TOKEN=$(FF_CONNECT_ENABLED=1 vercel connect token "$CONNECTOR" --subject app 2>/dev/null \
  | grep -vE '^[[:space:]]*$|Vercel CLI|^>|Retrieving|Fetching' | tail -1)
if [ -z "$TOKEN" ]; then
  echo "⚠ could not obtain a Slack token from Connect — skipping notification."
  exit 0
fi

TEXT=$(printf '🚀 *events-helper redeployed to production*\nCommit %s — %s\n\n*Changes since last deploy:*\n%s\n\n_%s_%s' \
  "$HEAD_SHORT" "${URL:-(url unknown)}" "$CHANGES" "$STAT" \
  "$( [ -n "$DIRTY" ] && printf '\n%s' "$DIRTY" )")

SLACK_TOKEN="$TOKEN" NOTIFY="$NOTIFY" TEXT="$TEXT" python3 - <<'PY'
import json, os, urllib.request
payload = {"channel": os.environ["NOTIFY"], "text": os.environ["TEXT"]}
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps(payload).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["SLACK_TOKEN"],
        "Content-Type": "application/json; charset=utf-8",
    },
)
try:
    resp = json.load(urllib.request.urlopen(req))
except Exception as e:  # noqa: BLE001
    print(f"⚠ Slack request failed: {e}")
else:
    print("✓ operator notified" if resp.get("ok") else f"⚠ Slack error: {resp.get('error')}")
PY
