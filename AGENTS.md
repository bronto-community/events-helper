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
  agent.ts                 # model = env EVE_MODEL; per-session token limits (lib/usage)
  instructions.md          # always-on system prompt (purpose + how to use the tools)
  instructions/
    usage.ts               # dynamic: injects token-budget status so the agent self-warns
  instrumentation.ts       # OpenTelemetry → Bronto (OTLP/proto traces), env-driven
  hooks/
    usage.ts               # observe token usage: accumulate + log + ops alert on threshold/limit
  channels/
    eve.ts                 # built-in HTTP channel (placeholderAuth — see below)
    slack.ts               # Slack via Vercel Connect (connector slack/bronto-events-helper)
  connections/
    jira.ts                # Atlassian remote MCP, user-scoped Connect OAuth, writes gated on approval
  schedules/
    cfp-digest.ts          # weekly (Mon 08:00 UTC) CfP digest → Slack, uses GLOBAL interests
    source-scan.ts         # daily (07:00 UTC) source rescan → ops channel summary
    cfp-alerts.ts          # daily (06:30 UTC) per-user opt-in CfP + new-event alert DMs (interactive cards)
  tools/
    list_cfps.ts           # query CfPs (open, future deadlines, filters, sorted)
    list_events.ts         # query events (upcoming, filters, sorted)
    manage_sources.ts      # list/add/remove shared feed sources (JSON feeds + iCal/Meetup groups)
    manage_interests.ts    # get / set_global (admin) / set_personal / subscribe|unsubscribe (alerts)
    roles.ts               # report who the super admins/admins are + caller's role (Slack names best-effort)
    rescan_sources.ts      # on-demand source scan → posts totals + what's new to the ops channel
    format_cfp_issue.ts    # compose a Jira issue payload from a CfP (does not create it)
  lib/
    types.ts               # feed shapes + normalized Cfp/EventItem/Interests
    store.ts               # durable KV: private Vercel Blob, local-file fallback for dev
    sources.ts             # seed feeds + custom sources (shared catalog)
    feeds.ts               # fetch + normalize (epoch→ISO) + filter + sort (merges ocgroups + iCal)
    ocgroups.ts            # Open Community Groups events via its JSON search endpoint, cached in Blob
    ical.ts                # generic iCalendar (.ics) source: fetch/parse/normalize, cached per-feed; Meetup URL→feed resolver
    scan.ts                # source rescan: totals + diff vs last snapshot (Blob) → summary message
    usage.ts               # per-session token-usage state + limits/threshold (env-tunable)
    deploy.ts              # deployment provenance (semconv vcs.ref.head.revision / deployment.id) for traces+logs
    alerts.ts              # per-user opt-in alert ledger + computeUserAlerts (CfP new/closing-soon) + computeUserEventAlerts (new events, baselined)
    cards.ts               # Slack Block Kit builders for interactive CfP + event alert cards
    slack-notify.ts        # post text or Block Kit to a Slack channel/DM via the Connect app token
    interests.ts           # global/personal/effective resolution
    roles.ts               # caller identity + admin / super-admin (operator) roles
    log.ts                 # structured, trace-correlated logging (traceId/spanId from active span)
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
- **Token-usage awareness** (`lib/usage.ts` + `hooks/usage.ts` + `instructions/usage.ts`).
  Per-session ceilings set on `defineAgent({ limits })` (env-tunable) fail the next call with
  `SESSION_TOKEN_LIMIT_REACHED`. The hook accumulates `step.completed` usage into durable session
  state, logs running totals (trace-correlated), alerts the ops channel once at `EVE_TOKEN_WARN_PCT`
  and on token-limit/rate-limit `turn.failed`, and counts compactions. Dynamic instructions inject a
  budget line each turn so the agent proactively warns the user. Model usage per turn is also on the
  Bronto spans + Vercel Agent Runs (`$eve.*` tags) — this adds session-cumulative awareness + limits.
- **Per-user alerts are opt-in** (`lib/alerts.ts`). A daily schedule DMs each **subscribed**
  user (ledger `events-helper/alerts/user/<principalId>.json`, subscription flag lives there, not in
  the interest profile) the CfPs matching their effective interests that are newly matched or
  closing-soon, **plus newly-announced events** matching their interests (e.g. from watched Meetup
  groups), as interactive Block Kit cards. Buttons (`cfp_dismiss`/`cfp_snooze`/`event_dismiss`/
  `event_snooze`) are handled by the Slack channel's `onInteraction` (side-effects only — a button
  can't start a turn); "file to Jira" is a DM reply. One subscription covers both CfPs and events.
  **Event alerts are baselined on first run** (`eventBaselineAt`): the first pass records the current
  matches and sends nothing, so a user only ever gets events announced *after* they subscribed, never
  a backlog flood (events are far higher-volume than CfPs). The ledger is normalized on read
  (`{...EMPTY_LEDGER, ...stored}`) so older CfP-only ledgers back-fill the event fields safely.
  Subscribers enumerated via `store.listKeys`. Cards are raw Block Kit (`lib/cards.ts`), not the JSX
  card DSL, so we control button `action_id`/`value`. Toggle events off independently with
  `EVENTS_HELPER_EVENT_ALERTS_ENABLED=false`.
- **Meetup = generic iCal, not a bespoke integration** (`lib/ical.ts`). We deliberately did **not**
  build a Meetup API client. Meetup's official API is Pro-only/own-groups and its ToS forbids bulk
  aggregation + HTML scraping — but every **public** group publishes an official iCalendar feed at
  `meetup.com/<group>/events/ical/`, which is exactly what a calendar app subscribes to. So we built
  a **generic iCal source kind** (`kind: "ical"` on `Source`): any `.ics` URL becomes an events
  source, fetched + parsed (RFC 5545: line-unfolding, params, `DTSTART` date parse at day
  granularity) + normalized to `EventItem`, cached per-feed in Blob with a TTL (`ICAL_CACHE_TTL_MIN`)
  so we poll politely. `manage_sources` resolves a Meetup group URL/`meetup:<slug>` to its feed and
  validates on add (private groups return `403 Invalid feed signature` → rejected with a clear
  message). Watched-group events then flow through `queryEvents`, the digest, the source scan
  (team-wide "what's new" to the ops channel), and per-user event alerts. This **reverses** the
  earlier "skip Meetup" decision, which was about *bulk aggregating all of Meetup* — a curated
  watchlist of public iCal feeds is a different, legitimate use. Gate with `ICAL_ENABLED=false`.
- **Roles** (`lib/roles.ts`): **admins** (`EVENTS_HELPER_ADMIN_IDS`) may edit global settings;
  **super admins / operators** (`EVENTS_HELPER_SUPER_ADMIN_IDS`) are a superset with extra
  privileges. Open until either list is configured, then enforced. Identity comes from
  `ctx.session.auth.current`, never the model.
- **Jira = Atlassian remote MCP** via Vercel Connect, **user-scoped** (each user signs in with
  their own Atlassian account). Writes gated on approval by a name-based policy.
- **Slack + Jira run through Vercel Connect** — no bot tokens/signing secrets in code.
- **Observability datasets** (Bronto collection `events-helper`): traces **and** runtime logs share
  `agent-runtime` (`BRONTO_DATASET`); deployment events go to `agent-deployments`
  (`BRONTO_DEPLOY_DATASET`). Keep this split — don't send logs to the deploy dataset or vice versa.
- **Deployment provenance for correlation** (`lib/deploy.ts`). Traces (OTel resource attributes) and
  every app log are stamped with OTel-semconv `vcs.ref.head.revision` (commit), `deployment.id`,
  `vcs.ref.head.name`, `deployment.environment.name`. The commit is injected by `scripts/deploy.sh`
  via `vercel deploy -e EVENTS_HELPER_COMMIT=<sha>` (matches the deploy log exactly); deployment id /
  env come from Vercel runtime env. The deploy log (`notify-deploy.mjs`) uses the same semconv keys,
  so you can filter `vcs.ref.head.revision=<sha>` (or `deployment.id`) across traces, logs, and the
  deployment event.
- **Traces export immediately** (`instrumentation.ts` uses a `SimpleSpanProcessor`, not the default
  batch). In the serverless/Workflow runtime a batch could go unflushed before the instance
  suspended, dropping spans — which left some logs (pushed immediately) referencing a `traceId` whose
  trace never reached Bronto. Immediate per-span export matches the log push and fixes that.
- **Observability**: OTLP traces → Bronto (`instrumentation.ts`); structured app logs via `lib/log.ts`
  carry the active `traceId`/`spanId` so they correlate with those spans. Use `log.info/warn/error`
  in tools/lib for meaningful events (never log secrets). `lib/log.ts` also **pushes logs directly to
  Bronto `/v1/logs`** (fire-and-forget) when Bronto env is set, so logs reach Bronto on a **free Vercel
  plan** without a drain — set `BRONTO_DIRECT_LOGS=false` once a Vercel log **Drain** (Pro+; see README)
  is live, to avoid duplicates. The deploy script also emits a deployment log to Bronto.

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

## Telemetry conventions (required)

All telemetry — **logs, metrics, and traces** — MUST follow OpenTelemetry semantic conventions.

- **Before adding any attribute, check the OTel semconv registry**
  (<https://opentelemetry.io/docs/specs/semconv/>). If a suitable attribute exists, use its exact
  key: e.g. `error.type`, `user.id`, `user.roles`, `url.full`, `service.name`, `deployment.id`,
  `deployment.environment.name`, `vcs.ref.head.revision`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`.
- **Do not invent keys that duplicate/collide with semconv**, and **do not use deprecated ones**
  (e.g. `error.message` is deprecated → use `error.type` for a low-cardinality class + put variable
  text in the log body or `events_helper.error.detail`).
- **No semconv equivalent? Namespace it under `events_helper.*`** (snake_case segments), e.g.
  `events_helper.query.matched`. Never place custom data under reserved/semconv namespaces.
- **Framework attributes keep eve's keys** (e.g. `eve.session.id`) so logs correlate with eve's
  spans.
- Applies to `agent/lib/log.ts` call sites, `agent/lib/deploy.ts`, `agent/instrumentation.ts`, and
  `scripts/notify-deploy.mjs`. When adding a log/attribute, confirm the key against semconv first.

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

Vercel project: `brontoio/events-helper` (team `brontoio`, project `prj_UVBCFToFKHcBiVVGdGrCF9V21jto`),
on a Pro plan. SSO deployment protection is **disabled** (required so Slack/Connect webhooks reach the
app; app-layer auth still guards routes). Both Connect connectors live under this team with the default
UIDs (`slack/bronto-events-helper`, `mcp.atlassian.com/atlassian`), and the Slack trigger is re-pointed
to `/eve/v1/slack`. The managed Slack app is `@brontoeventshelper` — invite it to the digest and ops
channels after any fresh Connect (re)install. See `README.md` for the full env-var list and one-time
Connect setup.

## Environment variables

| Var | Purpose |
| --- | --- |
| `EVE_MODEL` | Model id (default `anthropic/claude-sonnet-5`) |
| `EVE_MAX_INPUT_TOKENS` | Per-session input-token ceiling (default 10,000,000) |
| `EVE_MAX_OUTPUT_TOKENS` | Per-session output-token ceiling (default 1,000,000) |
| `EVE_TOKEN_WARN_PCT` | % of budget that triggers the ops-channel token warning (default 80) |
| `AI_GATEWAY_API_KEY` | AI Gateway credential (or use Vercel OIDC via `eve link`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token (persistence; else local-file fallback) |
| `BRONTO_OTLP_ENDPOINT` | Bronto OTLP base URL, e.g. `https://ingestion.eu.bronto.io` |
| `BRONTO_API_KEY` | Bronto ingest key (`x-bronto-api-key`) |
| `BRONTO_COLLECTION` | Bronto collection (default `events-helper`) |
| `BRONTO_DATASET` | Dataset for **traces + runtime logs** (`agent-runtime`) |
| `BRONTO_DEPLOY_DATASET` | Dataset for **deployment events** (`agent-deployments`) |
| `BRONTO_RECORD_IO` | `false` to redact prompts/outputs from spans |
| `BRONTO_DIRECT_LOGS` | `false` to stop the agent pushing logs straight to Bronto (use once a Vercel log drain is live, to avoid dupes) |
| `SLACK_DIGEST_CHANNEL_ID` | Target channel for the weekly digest (unset = digest no-ops) |
| `EVENTS_HELPER_ADMIN_IDS` | Comma-separated principal ids allowed to set global settings |
| `EVENTS_HELPER_SUPER_ADMIN_IDS` | Comma-separated principal ids for operator(s); superset of admin |
| `EVENTS_HELPER_ALERTS_ENABLED` | `false` to disable the daily per-user alert DMs (CfPs + events) |
| `EVENTS_HELPER_EVENT_ALERTS_ENABLED` | `false` to disable just the per-user *event* alerts (keeps CfP alerts) |
| `EVENTS_HELPER_ALERT_WINDOW_DAYS` | Horizon for "new" matching CfPs/events (default 90) |
| `EVENTS_HELPER_ALERT_CLOSING_DAYS` | Deadline proximity for the "closing soon" CfP nudge (default 7) |
| `EVENTS_HELPER_SNOOZE_DAYS` | How long a "Snooze" mutes a CfP/event (default 30) |
| `OCGROUPS_ENABLED` | `false` to drop the Open Community Groups events provider |
| `OCGROUPS_CACHE_TTL_MIN` | Minutes to cache ocgroups events (default 60) — bounds requests to that platform |
| `ICAL_ENABLED` | `false` to drop all iCal sources (Meetup groups + other `.ics` feeds) |
| `ICAL_CACHE_TTL_MIN` | Minutes to cache each iCal feed (default 60) — bounds polling of Meetup etc. |
| `EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL` | Slack channel/user id the deploy wrapper DMs on redeploy |
| `SLACK_CONNECTOR` | Slack Connect connector uid (default `slack/bronto-events-helper`) |
