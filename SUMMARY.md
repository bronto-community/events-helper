# events-helper — build summary

A factual, detailed record of what was built, what was asked for, the decisions made along the
way, and the problems solved. Intended as raw material for a blog post — not a polished draft.

- **What:** a durable AI agent that tracks conference CfPs/events, matches them to per-user
  interests, files them into Jira, and posts a weekly digest to Slack.
- **Stack:** [eve](https://eve.dev) framework (v0.18.x) · TypeScript (NodeNext) · Vercel (deploy,
  Cron, Connect, Blob) · Anthropic `claude-sonnet-5` via Vercel AI Gateway · OpenTelemetry → Bronto.
- **Built collaboratively** with Claude Code over one session, plan-first, verifying each layer.

---

## 1. The original ask

The project was scaffolded as an empty eve agent. The owner's opening brief (paraphrased from
their own words):

> "The bot should have a set of **sources** it draws events from — especially the **CfPs** at
> `https://developers.events/all-cfps.json`, and also `https://developers.events/all-events.json`.
> Not everything is listed there, so it should be easy to **add more sources**, or even better,
> **send the agent on a hunt** and incorporate what it finds. It should **answer questions** about
> those — most importantly, *what are the upcoming CfPs I'm interested in* — so there needs to be a
> way to **outline what kinds of events** I'm looking for. It should **send scheduled messages into
> Slack**, and be able to **put events as issues into Jira** and manage them from there.
> **Don't build anything yet — make a plan first, and verify what already exists vs. building from
> scratch.**"

That last instruction shaped the whole session: research first, reuse eve's built-ins, build only
the gaps.

## 2. Research and plan

Read the bundled eve docs (`node_modules/eve/docs/`) and fetched samples of both data feeds to
learn their shape:

- **CfPs:** `{ link, until, untilDate (epoch ms), conf: { name, date[], hyperlink, status, location } }`
- **Events:** `{ name, date[], hyperlink, location, city, country, cfp{}, status, tags[] }`
  (both feeds contain entries going back to 2019, so filtering out past items was essential).

Key finding — **reuse, don't build**:

- Web "hunt" needs no code: eve ships built-in `web_search` + `web_fetch` tools.
- Slack is a built-in eve channel; Jira is a Connection (Atlassian MCP); scheduled Slack messages
  are an eve Schedule; all credentials broker through **Vercel Connect** (no bot tokens in code).
- Only the domain logic (feed fetch/normalize/filter, interests, sources, a Jira formatter) had to
  be written.

Three decisions were put to the owner:

| Question | Choice |
| --- | --- |
| Persistence for interests + discovered sources | **External store** (started as Upstash, later switched to Vercel Blob) |
| Jira access | **Atlassian remote MCP + Vercel Connect** |
| Model | **Runtime-configurable** → implemented as `EVE_MODEL` env var |

## 3. What was built

**Domain library (`agent/lib/`)**

- `types.ts` — raw feed shapes + normalized `Cfp` / `EventItem` / interest types.
- `feeds.ts` — fetches every configured source, converts epoch-ms dates to ISO, **drops
  past/closed entries**, filters by keyword/location/deadline window, sorts by soonest.
- `sources.ts` — seed feeds (the two developers.events URLs) + a shared catalog of added sources.
- `store.ts` — durable KV. **Private Vercel Blob** in production; a local JSON file as a dev
  fallback so `eve dev` works with no external service.
- `interests.ts` — the two-layer interest model (added late; see §7).

**Tools (`agent/tools/`)** — typed with Zod:

- `list_cfps`, `list_events` — query the feeds with filters.
- `manage_sources` — list/add/remove shared feed sources (the "hunt then incorporate" path).
- `manage_interests` — get / set_global / set_personal (see §7).
- `format_cfp_issue` — composes a clean Jira issue payload (summary, description with
  deadline/dates/links, labels) without touching Jira; the agent hands it to the Jira create tool.

**Integrations & runtime**

- `agent/agent.ts` — `model: process.env.EVE_MODEL || "anthropic/claude-sonnet-5"`.
- `agent/instructions.md` — the always-on system prompt (purpose + how to use each tool).
- `agent/channels/slack.ts` — Slack via `connectSlackCredentials`.
- `agent/connections/jira.ts` — Atlassian remote MCP, user-scoped OAuth, writes gated on approval.
- `agent/schedules/cfp-digest.ts` — weekly (Mon 08:00 UTC) digest to Slack, gated on
  `SLACK_DIGEST_CHANNEL_ID`, conditional delivery (silent when nothing matches).
- `agent/instrumentation.ts` — OpenTelemetry export to Bronto (added later; see §8).

## 4. Verifying before credentials existed

Before any model credential was available, `eve dev` booted but model calls returned a 401 from
the AI Gateway. Rather than wait, the feed logic was verified **independently of the model**: the
`agent/lib` modules were compiled and run against the **live** developers.events data. Result:
correct sort by soonest deadline, past deadlines filtered out, keyword and location filters
working. This proved the hardest-to-get-right part early.

## 5. Persistence: Upstash → Vercel Blob

Persistence started as Upstash Redis (REST) with a local-file fallback. When the owner asked what
the alternatives were and expressed a preference to stay in the Vercel ecosystem, it was switched
to **Vercel Blob**. A subtlety drove the final shape: Blob's content URLs are public, so the store
uses **private** blobs (`access: "private"`, one JSON blob per key, keys as pathnames). Verified
end-to-end once the `BLOB_READ_WRITE_TOKEN` was set: a write + read in one turn, then a **fresh
session** read returned the same data — proving durable, cross-session persistence (not session
state). Edge Config was considered and rejected (its writes are eventually-consistent, awkward for
the agent's "set then immediately read" flow).

## 6. The Slack debugging saga (good blog material)

After the owner created the Slack Connect connector and wired the UID, messaging the bot did
nothing. Diagnosing "it's not working" turned up **four independent causes**, found by inspecting
Vercel state rather than guessing:

1. **Wrong trigger path.** `vercel connect create slack --triggers` points the webhook at
   Connect's default path, which eve doesn't serve. Fix: `detach` then
   `attach --triggers --trigger-path /eve/v1/slack`.
2. **Stale deploy.** The live production build predated the code that wired the real connector
   UID, so it still referenced a placeholder that didn't exist. Fix: redeploy.
3. **No production env vars.** `AI_GATEWAY_API_KEY` and `BLOB_READ_WRITE_TOKEN` existed only in
   local `.env.local`. Fix: add them to Vercel (prod/preview/dev).
4. **Vercel Deployment Protection (SSO).** Every route 302-redirected to `vercel.com/sso-api`, so
   Slack webhooks never reached the app. Fix: `vercel project protection disable --sso`. The app
   still guards itself — the Slack route verifies Vercel OIDC (unsigned `POST` → 401), and the HTTP
   route uses an auth policy. Confirmed reachable afterwards.

Takeaway worth writing up: a webhook-driven agent on Vercel needs the trigger path, a current
deploy, prod env vars, **and** platform protection all lined up — any one breaks it silently.

## 7. Per-user interests, two layers (the interesting product bit)

Interests started as a single shared record. The owner asked whether, with Slack as the main
interface, that was one entry or per user — and specified the model they actually wanted:

> "A mixture: a **global setting** and an **individual setting**. Global is always part of the
> individual, **except** when the user says 'I don't care about X' where X is in global (they can
> exclude it). Global is set by **admins** (or gathered from overall interest). The **digest** uses
> the global."

Implemented in `agent/lib/interests.ts` + a rewritten `manage_interests`:

- **Global** profile (`events-helper/interests/global.json`) — admin-managed, drives the digest.
- **Personal** overlay per user (`events-helper/interests/user/<principalId>.json`) — adds and
  excludes.
- **Effective** = `(global ∪ personal.add) − personal.exclude`, case-insensitive.
- The caller's identity comes from `ctx.session.auth.current` — the **verified** Slack user, never
  model input. Admin rights gated by `EVENTS_HELPER_ADMIN_IDS` (open until configured).
- The digest runs as the *app* principal (no user), so it naturally resolves to the global set.
- **Sources stay a shared team catalog** — a feed anyone discovers benefits everyone.

Verified with three real turns: admin sets global (`kubernetes, observability / Europe`); a user
excludes kubernetes and adds rust; the effective result is `observability, rust / Europe`.

Not yet built (owner flagged as a future want): auto-deriving the global profile by **aggregating**
everyone's interests (needs listing over the per-user Blob keys).

## 8. Observability → Bronto

The owner asked to use eve's out-of-the-box OpenTelemetry support and send traces to Bronto.
eve auto-discovers `agent/instrumentation.ts`; using `@vercel/otel`'s `OTLPHttpProtoTraceExporter`,
spans go to Bronto over OTLP/HTTP protobuf. Bronto's config was researched from its own docs:
endpoint `https://ingestion.eu.bronto.io`, path `/v1/traces`, auth header `x-bronto-api-key`,
optional `x-bronto-collection` / `x-bronto-dataset`. All connection details are env-driven; the
file fails safe (no export) when unconfigured.

Verified by exporting a real span through the exact exporter — Bronto returned `{ code: 0 }`
(accepted). Per turn, Bronto receives a span tree: `ai.eve.turn` → `ai.streamText` (steps) →
`ai.streamText.doStream` (model calls) + `ai.toolCall` (tools), with session/turn/token attributes.
(Separately, eve emits framework "Agent Runs" telemetry to Vercel's own dashboard automatically.)

## 9. Notable decisions & guardrails

- **Model can't switch per-conversation** in eve (resolved once at load), so "runtime-configurable"
  became an env var — honest about the constraint.
- **Approval gates** on Jira writes; **verified-auth-only** identity for interests; **private** Blob
  storage — the sensitive/irreversible actions are guarded, per eve's responsible-use guidance.
- **Deploy consent:** production deploys were confirmed each time until the owner granted a standing
  "always redeploy for me," after which deploys proceed automatically. (A safety classifier actually
  blocked one deploy that fell outside prior consent — the guardrail worked.)
- **Secrets** pasted during setup were flagged for rotation; they live only in env vars.

## 10. Final state

- Deployed to Vercel production (`events-helper.vercel.app`), SSO disabled for webhook delivery.
- Slack connector `slack/bronto-events-helper` routed to `/eve/v1/slack`; Jira connector
  `mcp.atlassian.com/atlassian` (user-scoped).
- Persistence on private Vercel Blob; traces flowing to Bronto (EU).
- Env configured across prod/preview/dev.

**Open items the owner may still want:** set `EVENTS_HELPER_ADMIN_IDS` to lock down global-interest
editing; set `SLACK_DIGEST_CHANNEL_ID` to turn on the weekly digest; a real auth policy on the HTTP
channel before any browser UI; optional global-interest aggregation; optional region→countries
mapping so a broad location like "Europe" matches precisely.

## 11. Repository hygiene, licensing & docs

Late in the session the project was turned into a proper repo: **Apache-2.0** license added
(`package.json` `license` set to match); **husky** pre-commit tooling wired to run **gitleaks**
(secret scanning of staged changes, with a regex fallback if gitleaks isn't installed), a
**typecheck** gate, and a **docs-sync reminder** that warns when `agent/` changes without a matching
doc update. Four docs are maintained going forward — `AGENTS.md` (agent/contributor guide),
`README.md` (install/operate), `docs/USER-GUIDE.md` (end users), and this `SUMMARY.md` — with a
standing instruction (in AGENTS.md and agent memory) to keep them continuously in sync. The initial
substantive commit was made only after confirming no credentials were in tracked files (`.env.local`
and the local Blob fallback are gitignored).

## 12. Roles & deploy notifications

A role hierarchy was introduced (`agent/lib/roles.ts`): **admins**
(`EVENTS_HELPER_ADMIN_IDS`) may edit global settings; **super admins / operators**
(`EVENTS_HELPER_SUPER_ADMIN_IDS`) are a superset with extra privileges. Identity is read from
verified session auth; access is open until either list is configured, then enforced. The
`manage_interests get` response now reports the caller's `role`, so anyone can find their principal
id ("what's my id?") for an operator to add to the lists.

The first operator privilege: **deploy notifications**. `scripts/deploy.sh` (wired as
`npm run deploy`) diffs git since the last recorded deploy (`.last-deploy-sha`), runs the
production deploy, and then DMs the operator (`EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL`) a summary of
the changes using the bot's Slack Connect token (fetched at runtime, never printed). Deploys should
now go through this wrapper so the operator is always notified; the raw `vercel deploy` still works
but skips the notice.

## 13. Roles visibility

Configuring the roles surfaced a gap: the agent could report the *caller's* role but had no way to
answer "who are the admins/super admins?" and improvised that it had no visibility. Added a `roles`
tool (`agent/tools/roles.ts`) that lists the configured super admins and admins plus the caller's
role, resolving `slack:<team>:<Uxxxx>` principals to display names via the Slack API (best-effort,
needs `users:read`; falls back to ids). Instructions updated so the agent uses it for any
roles/permissions question instead of guessing. It also returns a `mention` string (`<@Uxxxx>`) per
person so replies can tag people as clickable Slack @mentions (with the caveat that tagging pings
them).

## 14. Logs (trace-correlated) & deployment logs

Extended observability beyond traces:

- **Application logs** — `agent/lib/log.ts` emits structured JSON logs stamped with the active
  OpenTelemetry `traceId`/`spanId` (from `@opentelemetry/api`, already a dependency), so every log
  lines up with the spans already going to Bronto. Added meaningful, non-spammy log calls: feed
  query summaries and per-source fetch failures (`lib/feeds.ts`), global/personal interest changes
  and unauthorized `set_global` attempts (`manage_interests`), and source add/remove
  (`manage_sources`). Verified locally that a turn emits e.g.
  `{"level":"info","message":"cfps queried","traceId":"…","spanId":"…","matched":2,…}`.
- **Deployment logs via Vercel Drains** — the answer to "does Vercel give me something": Vercel
  **Drains** forward runtime/build/deployment logs (and traces) to an external sink; Bronto has a
  documented custom-endpoint log drain (Team Settings → Drains → Logs → `https://ingestion.<region>.bronto.io/`
  + `x-bronto-*` headers; **Pro/Enterprise**). Vercel auto-enriches traced-request logs with
  `traceId`/`spanId`. Note: log drains use JSON/NDJSON (only *trace* drains are OTLP), but Bronto's
  integration ingests them.
- **Direct deploy log** — `scripts/notify-deploy.mjs` now also POSTs an OTLP-JSON log to Bronto's
  `/v1/logs` on each `npm run deploy` (commit + change summary), validated with an HTTP 200, so a
  durable deployment event lands in Bronto regardless of the drain/plan.
- **Free-plan app logs** — since Vercel log drains need a Pro plan, `lib/log.ts` also **pushes each
  log straight to Bronto `/v1/logs`** (fire-and-forget OTLP-JSON, with native `traceId`/`spanId` for
  correlation) whenever the Bronto env is present. This gets app logs into Bronto on a free Vercel
  plan with no drain; a `BRONTO_DIRECT_LOGS=false` toggle disables it once a drain is live (to avoid
  duplicates). Validated the payload returns HTTP 200 and a live turn ships correlated logs.

## 15. Dataset split in Bronto

Observed that traces, runtime logs, and deployment events were all landing in one dataset
(`agent-traces` — a poorly-chosen name). Reorganized the Bronto `events-helper` collection into two
datasets: **`agent-runtime`** for traces + runtime logs (they belong together, correlated by trace
id) and **`agent-deployments`** for deployment events. `BRONTO_DATASET` now = `agent-runtime` (used
by the trace exporter and `lib/log.ts`); new `BRONTO_DEPLOY_DATASET` = `agent-deployments` (used by
`scripts/notify-deploy.mjs`). Env updated across prod/preview/dev. (Old `agent-traces` data stays as
history in Bronto.)

## 16. Open Community Groups as a source

Added CNCF [Open Community Groups](https://ocgroups.dev) as an events source. The site is an htmx app
with "no API yet", but investigation found its Leaflet map is backed by a JSON endpoint —
`GET /explore/events/search?limit=<=100&offset=N` → `{ events, total, bbox }` — so no HTML scraping
is needed. Built `agent/lib/ocgroups.ts`: a single paginated JSON pull (page size capped at 100),
normalized to our `EventItem` shape (starts_at/ends_at are Unix seconds; kind virtual/in-person/
hybrid → location; group name/category → tags), and **cached in Blob with a TTL** (default 60 min,
`OCGROUPS_CACHE_TTL_MIN`) so we hit the platform at most ~once/hour regardless of query volume —
directly addressing "don't overwhelm the platform". Merged into `queryEvents` (behind
`OCGROUPS_ENABLED`), surfaced in `manage_sources` list and the instructions. Verified: events flow
into `list_events` (99 pulled, one refresh log, trace-correlated) alongside the developers.events
feed. These are meetup-style events (no CfPs).

## 17. Source rescan → ops channel

Added a source rescan that notifies the ops channel like deployments do. `agent/lib/scan.ts` pulls
everything upcoming across all sources, diffs against the previous scan (a snapshot of CfP/event ids
stored in Blob) to find what's new, and formats a summary (sources scanned, total CfPs/events,
ocgroups count, and the new items). `agent/lib/slack-notify.ts` posts it to the ops channel
(`EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL`) via the Connect app token — the same runtime mechanism the
deploy notifier proved out. Two triggers (as requested): a daily schedule
(`agent/schedules/source-scan.ts`, 07:00 UTC) and an on-demand `rescan_sources` tool. Every scan
posts totals + what's new; the first scan records a baseline. Verified on demand: scanned 3 sources
(178 CfPs, 893 events incl. 99 ocgroups), posted to the ops channel.

## 18. Per-user CfP alerts as interactive Slack cards (opt-in)

Delivered the two chosen backlog features as one capability. `agent/lib/alerts.ts` holds a per-user
ledger (`events-helper/alerts/user/<principalId>.json`) with the **subscription flag** (kept out of
the interest profile so interest edits don't clobber it) plus notified/reminded/dismissed/snoozed
ids; `computeUserAlerts` returns the CfPs matching a user's effective interests that are newly
matched (within `ALERT_WINDOW_DAYS`) or newly closing-soon (`ALERT_CLOSING_DAYS`). A daily schedule
`agent/schedules/cfp-alerts.ts` enumerates subscribers (new `store.listKeys` over Blob), DMs each the
CfPs as **interactive Block Kit cards** (`agent/lib/cards.ts`, raw blocks for full control of button
`action_id`/`value`) via `postBlocks` (`agent/lib/slack-notify.ts`). Buttons: Submit (link),
Not-interested (`cfp_dismiss`), Snooze (`cfp_snooze`) — handled by the Slack channel's new
`onInteraction` (side-effects + `chat.update`; a button can't start a turn, so filing to Jira is a
DM reply). Opt-in via `manage_interests` `subscribe`/`unsubscribe`.

Verified: subscribe writes a ledger; the dispatched schedule enumerated `subscribers:1`; a standalone
run of `computeUserAlerts` for a "kubernetes" user returned matches and built valid cards
(`section,actions` with the three action_ids, ref encode/decode round-trip). Confirmed Vercel Blob
accepts `:` in pathnames (per-user keys embed the `slack:team:U` principal), so no key sanitizing
needed.

Prereqid Slack setup for full function: the bot needs `im:history` + the `message.im` event
subscription (so DM replies reach the agent) and **Interactivity enabled** pointing at
`/eve/v1/slack` (so button clicks reach `onInteraction`).

## 19. Token-usage awareness

Finished the paused token-usage feature. `agent/lib/usage.ts` holds per-session usage state +
env-tunable ceilings (`EVE_MAX_INPUT_TOKENS`/`EVE_MAX_OUTPUT_TOKENS`, default 10M/1M) wired onto
`defineAgent({ limits })` so the next call after a ceiling fails with `SESSION_TOKEN_LIMIT_REACHED`.
`agent/hooks/usage.ts` accumulates `step.completed` usage, logs running totals (trace-correlated),
alerts the ops channel once at `EVE_TOKEN_WARN_PCT` (default 80) and on token-limit/rate-limit
`turn.failed`, and counts compactions. `agent/instructions/usage.ts` (dynamic, coexisting with
`instructions.md`) injects a budget line each turn so the agent proactively warns the user when a
conversation is getting large. Verified locally: the hook logged accumulating `token usage`
(steps 1→3, input 10k→32k), trace-correlated, no errors.

## 20. Prepared for public release (bronto-community, Apache-2.0)

Readied the repo for GitHub `bronto-community` under Apache-2.0. Security-audited the full git
history with gitleaks (13 commits, no leaks) and confirmed no secrets/real infra ids in tracked
files. Genericized the Bronto-specific Vercel Connect connector UIDs to env-driven
(`SLACK_CONNECTOR`/`JIRA_CONNECTOR`, defaults retained) and scrubbed a connector id from a comment.
Added `NOTICE` (Copyright 2026 Bronto + third-party attributions), `CONTRIBUTING.md`, `SECURITY.md`
(security@bronto.io + GitHub advisories), `CODE_OF_CONDUCT.md` (Contributor Covenant), a GitHub
Actions CI workflow (type-check + gitleaks), README license/CI badges + community disclaimer, and
package.json metadata (repository/description/keywords, v0.1.0). `docs/blog-*` is gitignored so the
blog draft stays private.

## 21. Deployment ↔ traces/logs correlation

The deploy log carried the commit but traces + runtime logs didn't, so you couldn't cross-correlate
by deployment. Added `agent/lib/deploy.ts` exposing OTel-semconv deployment provenance —
`vcs.ref.head.revision` (commit; there is no `deployment.commit` in semconv — it lives in the VCS
namespace), `deployment.id`, `vcs.ref.head.name`, `deployment.environment.name`. Stamped onto every
span (via `registerOTel({ attributes })`) and every app log (`lib/log.ts`, console + Bronto push,
resource-level). The commit is injected at deploy time by `scripts/deploy.sh`
(`vercel deploy -e EVENTS_HELPER_COMMIT=<full sha>`) so it exactly matches the deploy log; the
deploy log (`notify-deploy.mjs`) was realigned to the same semconv keys (and grabs the Vercel
`dpl_` id for `deployment.id`). Result: filter `vcs.ref.head.revision=<sha>` (or `deployment.id`)
across traces, logs, and deployment events in Bronto. Verified logs carry the attributes when the
commit env is set.

## 22. Fix: logs referencing traces missing from Bronto

Some logs (e.g. "token usage") carried a `traceId` with no matching trace in Bronto. Traced it: the
hook logs run inside `context.with(ai.eve.turn span)` (confirmed in eve's `harness/tool-loop.js`), so
the `traceId` is genuinely the turn's trace — the problem was **export**, not a wrong id. Traces used
`@vercel/otel`'s default **batch** span processor (flush every ~5s / on shutdown); in the
serverless/Workflow runtime an instance can suspend before a batch flushes, dropping spans, while our
logs are pushed to Bronto immediately. Switched to a **`SimpleSpanProcessor`** (immediate per-span
export) via `registerOTel({ spanProcessors })`, added `@opentelemetry/sdk-trace-base` as an explicit
dep (2.x, matches `@vercel/otel`'s peer range). Verified the server boots with the new wiring; full
confirmation is fewer orphaned traceIds in Bronto going forward.

## 23. Telemetry follows OpenTelemetry semantic conventions (standing rule + audit)

Added a permanent rule (AGENTS.md "Telemetry conventions" + agent memory): all logs/metrics/traces
MUST follow OTel semconv — check the registry before adding an attribute; use the exact key if one
exists; otherwise namespace under `events_helper.*` (snake_case); framework attrs keep eve keys
(`eve.session.id`). Then audited and fixed the logs (they were partially ad-hoc):

- `error: String(err)` → semconv `error.type` (low-cardinality class; `error.message` is deprecated)
  + `events_helper.error.detail` for the text, via a new `errorAttributes()` helper in `lib/log.ts`.
- principal/`by`/`user` → `user.id`; role → `user.roles` (array).
- feed `url` → `url.full`; `service` field → `service.name`.
- token usage → GenAI semconv `gen_ai.usage.input_tokens`/`output_tokens` (per step, matching the AI
  SDK spans); cumulative/session totals + budget under `events_helper.session.*`; `sessionId` →
  `eve.session.id` (matches eve's span attribute → correlates).
- all remaining domain fields (query counts/filters, scan totals, alert counts, source id/kind,
  slack action id, cfp id) → `events_helper.*`.

Traces were already compliant (`service.name` + `deployment.*` + `vcs.ref.head.revision` resource
attrs; AI-SDK `gen_ai.*` spans), so no trace changes were needed. Verified logs emit the new keys.

## Appendix: prompts/asks in order

1. "Build a bot with CfP/event sources (developers.events), easy to add sources or hunt for them,
   answer 'upcoming CfPs I'm interested in', scheduled Slack messages, Jira issues + management —
   **plan first, verify reuse vs. build**."
2. Chose: external persistence · Atlassian MCP for Jira · runtime-configurable model.
3. "Added `AI_GATEWAY_API_KEY` — is that enough?" · "What persistence alternatives?" · "Where and
   how for Jira/Slack?" → switched to Vercel Blob, added the Jira formatter.
4. Provided the Blob token; then ran the Jira and Slack Connect create commands.
5. "When I send Slack messages it's not working." → the four-cause fix.
6. "Is there anything left to do?"
7. "Add observability — eve's OOTB OpenTelemetry — send to Bronto."
8. "Always redeploy for me."
9. "How do I configure the events I'm interested in — is there a config file?"
10. "Is that one entry or per user (especially on Slack)?" → the two-layer global/personal model.
11. "Update AGENTS.md, write a README + end-user docs + this summary."
12. "Keep the four docs continuously updated; add Apache-2.0 LICENSE; commit to git with no
    credentials + good pre-commit tooling (gitleaks etc.); redeploy."
13. "Configure admins — plus a role model: a list of users who can change global settings, and a
    super-admin/operator with extra privileges. First privilege: the operator is always notified
    on redeploy with a summary of the changes."
14. "The bot couldn't tell me who the admins/super admins are." → added the `roles` tool + taught
    the agent about the role model.
15. "Tag (not just name) the users in the message." → `roles` returns Slack `<@Uxxxx>` mentions.
16. "Improve observability: reasonable logs that fit the traces, and deployment logs — does Vercel
    give me something?" → trace-correlated app logs + Bronto deploy log + Vercel Drains guidance.
17. "Continue with the free-plan part." → agent pushes logs directly to Bronto (no drain needed).
18. "Traces + runtime logs in one bucket, deployments in another (agent-traces was a bad name)." →
    split into `agent-runtime` and `agent-deployments` datasets.
19. "Add ocgroups.dev as a source — no API yet; find a smart way to pull without overwhelming it." →
    found its JSON search endpoint, single cached paginated pull, merged into events.
20. "When rescanning the sources, post an update to the admin channel like the deployments." →
    scheduled + on-demand source scan that posts totals + what's new to the ops channel.
21. "Add meetup.com as a source." → researched; it's a walled garden (Pro-only API, license
    forbids aggregation, scraping prohibited) → decided to skip.
22. "Suggest additional features" → catalog in the plan; user chose per-user alerts + interactive
    cards, built as one opt-in interactive-card DM capability.
23. "Make the agent aware of token usage + limits it's hitting." → per-session limits + usage hook
    (log + ops alerts) + dynamic budget-awareness instruction.
24. "deploy.commit isn't on traces+logs — I can't cross-correlate." → stamped commit/deployment id
    on traces + logs (OTel semconv `vcs.ref.head.revision` / `deployment.id`).
25. "Logs referencing a traceId with no trace in Bronto." → root-caused to batch-span-processor
    drops on serverless; switched to SimpleSpanProcessor (immediate export). Filed vercel/eve#679.
26. "Telemetry must always follow semantic conventions." → standing rule + audited/fixed logs to
    semconv (error.type, user.id/roles, url.full, gen_ai.usage.*, eve.session.id) + `events_helper.*`.
