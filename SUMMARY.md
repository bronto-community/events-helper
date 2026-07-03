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
