#!/usr/bin/env sh
# Pre-commit checks for events-helper. Run via husky (.husky/pre-commit) or
# directly with `npm run precommit`.

fail() { echo "$1"; exit 1; }

echo "▶ pre-commit: secret scan (gitleaks)"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --staged --no-banner --redact \
    || fail "❌ gitleaks found potential secrets in staged changes — commit aborted."
else
  echo "⚠ gitleaks not installed — falling back to a basic pattern scan."
  echo "  Install gitleaks for full coverage: https://github.com/gitleaks/gitleaks"
  if git diff --cached -U0 \
      | grep -qE 'vercel_blob_rw_|vck_[A-Za-z0-9]{8}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
    fail "❌ Possible secret in staged changes (fallback scan) — commit aborted."
  fi
fi

echo "▶ pre-commit: typecheck"
npm run --silent typecheck || fail "❌ typecheck failed — commit aborted."

# Soft reminder: keep the docs in sync with agent changes (not blocking).
changed=$(git diff --cached --name-only)
if echo "$changed" | grep -qE '^agent/' \
   && ! echo "$changed" | grep -qE '^(AGENTS\.md|README\.md|SUMMARY\.md|docs/USER-GUIDE\.md)$'; then
  echo "⚠ agent/ changed but none of AGENTS.md / README.md / SUMMARY.md / docs/USER-GUIDE.md were updated."
  echo "  Update the docs if this affects behavior, setup, or usage (reminder, not a block)."
fi

echo "✓ pre-commit checks passed"
