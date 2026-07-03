# events-helper — agent/contributor guide

This project uses the **eve framework** (durable, filesystem-first agents). Before
writing code, read the relevant guide from the installed eve package docs. In most
installs they are at `node_modules/eve/docs/`. In workspaces or local package
installs, resolve the installed `eve` package location first and read its `docs/`
directory. If package docs are unavailable, use https://eve.dev/docs as a fallback.

## What this agent does

Helps a team track tech-conference **Call for Papers (CfPs)** and events, matched to
each user's interests, filed into **Jira**, and summarized into **Slack** on a
schedule. Data comes from the [developers.events](https://developers.events) feeds
plus any feeds the agent discovers by web search.

## File map

```
agent/
  agent.ts                 # model = process.env.EVE_MODEL || "anthropic/claude-sonnet-5"
  instructions.md          # always-on system prompt (purpose + how to use the tools)
  instrumentation.ts       # OpenTelemetry → Bronto (OTLP/proto traces), env-driven
  channels/
    eve.ts                 # built-in HTTP channel (placeholderAuth — see below)
    slack.ts               # Slack via Vercel Connect (connector slack/bronto-events-helper)
  connections/
    jira.ts                # Atlassian remote MCP, user-scoped Connect OAuth, writes gated on approval
  schedules/
    cfp-digest.ts          # weekly (Mon 08:00 UTC) CfP digest → Slack, uses GLOBAL interests
  tools/
    list_cfps.ts           # query CfPs (open, future deadlines, filters, sorted)
    list_events.ts         # query events (upcoming, filters, sorted)
    manage_sources.ts      # list/add/remove shared feed sources
    manage_interests.ts    # get / set_global (admin) / set_personal — two-layer interests
    format_cfp_issue.ts    # compose a Jira issue payload from a CfP (does not create it)
  lib/
    types.ts               # feed shapes + normalized Cfp/EventItem/Interests
    store.ts               # durable KV: private Vercel Blob, local-file fallback for dev
    sources.ts             # seed feeds + custom sources (shared catalog)
    feeds.ts               # fetch + normalize (epoch→ISO) + filter + sort
    interests.ts           # global/personal/effective resolution
    roles.ts               # caller identity + admin / super-admin (operator) roles
```

Plus `scripts/deploy.sh` (deploy + operator notification), `scripts/notify-deploy.mjs` (Slack post
via Connect SDK), and `scripts/precommit.sh` (gitleaks + typecheck + docs-sync).

## Key decisions (why it's built this way)

- **Model is env-configurable** via `EVE_MODEL` (Vercel AI Gateway id). Resolved once at
  module load; change env + redeploy to switch. No per-conversation model swap in eve.
- **Persistence = private Vercel Blob** (`BLOB_READ_WRITE_TOKEN`), one JSON blob per key,
  keys are pathnames. Falls back to a local JSON file when the token is absent so `eve dev`
  works offline. Chosen over Edge Config (eventually-consistent writes) and Upstash.
- **Interests are two-layer and per-user.** GLOBAL (admin-managed, drives the digest) +
  PERSONAL overlay (add + exclude). `effective = (global ∪ personal.add) − personal.exclude`.
  Caller identity comes from `ctx.session.auth.current` (never model input). Admins gated by
  `EVENTS_HELPER_ADMIN_IDS` (open until set). **Sources are a shared team catalog.**
- **Roles** (`lib/roles.ts`): **admins** (`EVENTS_HELPER_ADMIN_IDS`) may edit global settings;
  **super admins / operators** (`EVENTS_HELPER_SUPER_ADMIN_IDS`) are a superset with extra
  privileges. Open until either list is configured, then enforced. Identity comes from
  `ctx.session.auth.current`, never the model.
- **Jira = Atlassian remote MCP** via Vercel Connect, **user-scoped** (each user signs in with
  their own Atlassian account). Writes gated on approval by a name-based policy.
- **Slack + Jira run through Vercel Connect** — no bot tokens/signing secrets in code.

## Keep the docs in sync (required)

Whenever you change behavior, setup, configuration, or the file layout, update the affected docs
**in the same change** — this is a standing requirement, not a nice-to-have:

| Doc | Keep current when you change… |
| --- | --- |
| `AGENTS.md` | file map, decisions, conventions, env vars, deploy flow |
| `README.md` | install/deploy steps, env vars, integration setup, scripts |
| `docs/USER-GUIDE.md` | anything an end user says to the bot, or user-visible behavior |
| `SUMMARY.md` | append what changed and why (it's the running build log / blog source) |

The pre-commit hook prints a reminder when `agent/` changes without a doc change. Treat env-var
changes as doc changes: update the tables in both `AGENTS.md` and `README.md`.

## Conventions

- **NodeNext modules**: relative imports use `.js` extensions (e.g. `../lib/feeds.js`).
- **Tools**: `defineTool` + Zod `inputSchema`; never trust the model for identity/tenancy — read
  it from `ctx.session.auth`. Gate state-changing external actions with approval.
- **Secrets** come from env vars only; never hard-code. Local secrets live in `.env.local`
  (gitignored). The local Blob fallback file `.events-helper-store.json` is gitignored.
- **Verify** with `npm run typecheck`, then `npm exec -- eve dev --no-ui` and exercise the HTTP
  API (`POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`). Model calls need an AI Gateway
  credential (`AI_GATEWAY_API_KEY` or `eve link`).

## Deploy

Standing instruction from the owner: **redeploy to production automatically after changes that
should go live** (no per-deploy confirmation needed).

Deploy through the wrapper so the operator is notified with a change summary:

```bash
npm run deploy   # scripts/deploy.sh: summary → deploy → Slack DM to the operator
```

It diffs `git` from the last recorded deploy (`.last-deploy-sha`, gitignored), deploys, then posts
the summary to `EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL` via `scripts/notify-deploy.mjs`. That helper
uses the `@vercel/connect` **SDK** with the OIDC token from env (the CLI cannot mint the app-subject
Slack token — only the runtime/OIDC can). Notification is **best-effort**: if `VERCEL_OIDC_TOKEN` is
missing/expired (refresh with `vercel env pull`), the deploy still succeeds and the notice is
skipped. The raw `VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod` also works but never
notifies.

Vercel project: `svrnm-otel/events-helper`. SSO deployment protection is **disabled** (required so
Slack/Connect webhooks reach the app; app-layer auth still guards routes). See `README.md` for the
full env-var list and one-time Connect setup.

## Environment variables

| Var | Purpose |
| --- | --- |
| `EVE_MODEL` | Model id (default `anthropic/claude-sonnet-5`) |
| `AI_GATEWAY_API_KEY` | AI Gateway credential (or use Vercel OIDC via `eve link`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token (persistence; else local-file fallback) |
| `BRONTO_OTLP_ENDPOINT` | Bronto OTLP base URL, e.g. `https://ingestion.eu.bronto.io` |
| `BRONTO_API_KEY` | Bronto ingest key (`x-bronto-api-key`) |
| `BRONTO_COLLECTION` / `BRONTO_DATASET` | Bronto routing labels (`events-helper` / `agent-traces`) |
| `BRONTO_RECORD_IO` | `false` to redact prompts/outputs from spans |
| `SLACK_DIGEST_CHANNEL_ID` | Target channel for the weekly digest (unset = digest no-ops) |
| `EVENTS_HELPER_ADMIN_IDS` | Comma-separated principal ids allowed to set global settings |
| `EVENTS_HELPER_SUPER_ADMIN_IDS` | Comma-separated principal ids for operator(s); superset of admin |
| `EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL` | Slack channel/user id the deploy wrapper DMs on redeploy |
| `SLACK_CONNECTOR` | Slack Connect connector uid (default `slack/bronto-events-helper`) |
