# events-helper

A durable AI agent that helps a team stay on top of **tech-conference Call for Papers
(CfPs)** and events — matched to what each person cares about, filed into **Jira**, and
delivered to **Slack** on a weekly schedule.

Built on the [eve framework](https://eve.dev) and deployed on Vercel.

- **Live sources** — pulls CfPs and events from the [developers.events](https://developers.events)
  feeds, and can hunt the web for more feeds and add them to a shared catalog.
- **Interest matching** — a team-wide profile plus a personal overlay per user (add your own
  topics, exclude ones you don't care about).
- **Jira** — turn a CfP into a tracked issue, then update/transition/comment on it.
- **Slack** — chat with the bot; get a weekly digest of upcoming CfPs.
- **Observability** — OpenTelemetry traces exported to [Bronto](https://bronto.io).

> **Using the bot?** See the [User Guide](docs/USER-GUIDE.md). This README is for installing
> and operating it.

---

## How it works

```
Slack / HTTP ──▶ eve agent (Vercel) ──▶ tools ──▶ developers.events feeds
                     │                          └▶ Vercel Blob (interests, sources)
                     ├─▶ Atlassian MCP (Jira)   via Vercel Connect
                     └─▶ weekly cron ─▶ Slack digest
                     traces ─▶ Bronto (OTLP)
```

The agent is a set of files under `agent/` (see [AGENTS.md](AGENTS.md) for the full map and
design decisions). eve runs the model loop, persists sessions, and serves the HTTP + Slack
routes.

## Prerequisites

- **Node 24+**
- A **Vercel account** + the Vercel CLI (`npm i -g vercel`) — deployment, Connect, and Blob run here.
- An **AI Gateway credential** (Vercel OIDC via `vercel link`, or an `AI_GATEWAY_API_KEY`).
- For the full feature set: a **Slack** workspace, an **Atlassian/Jira** cloud site, and a
  **Bronto** account (all optional — the core CfP/event querying works without them).

## Quick start (local)

```bash
npm install
# minimum credential for the model to run:
echo 'AI_GATEWAY_API_KEY="<your-key>"' >> .env.local   # or: vercel link
npm exec -- eve dev            # interactive REPL
# or headless, to drive over HTTP:
npm exec -- eve dev --no-ui
```

With no `BLOB_READ_WRITE_TOKEN` set, persistence uses a local file
(`.events-helper-store.json`), so you can try interests/sources offline.

Type-check any time with:

```bash
npm run typecheck
```

## Deploy to Vercel

```bash
vercel link          # first time: link/create the project
npm run deploy       # summarize changes → deploy → notify the operator on Slack
```

`npm run deploy` (`scripts/deploy.sh`) diffs git since the last deploy, runs the production
deploy, and DMs the operator (`EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL`) a change summary via the
bot's Slack token. To deploy without the notification, run the raw command:

```bash
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod
```

Set the environment variables below in the Vercel project (Settings → Environment Variables),
or with `vercel env add <NAME> production`.

### Roles

- **Admins** (`EVENTS_HELPER_ADMIN_IDS`) can change the team-wide **global** interest profile.
- **Super admins / operators** (`EVENTS_HELPER_SUPER_ADMIN_IDS`) are a superset with extra
  privileges (e.g. they receive the deploy notifications).
- Until either list is set, everyone is treated as an admin (bootstrap). Ask the bot
  *"what's my id?"* to get the principal id to put in these lists.

### Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `EVE_MODEL` | no | Model id, default `anthropic/claude-sonnet-5` |
| `AI_GATEWAY_API_KEY` | yes¹ | AI Gateway credential (¹or use Vercel OIDC via `vercel link`) |
| `BLOB_READ_WRITE_TOKEN` | recommended | Vercel Blob token for durable interests/sources |
| `SLACK_DIGEST_CHANNEL_ID` | for digest | Slack channel id the weekly digest posts to |
| `EVENTS_HELPER_ADMIN_IDS` | recommended | Comma-separated principal ids allowed to set **global** settings |
| `EVENTS_HELPER_SUPER_ADMIN_IDS` | recommended | Operator(s); superset of admin, with extra privileges |
| `EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL` | for deploy notices | Slack channel id (`Cxxxx`) or operator user id (`Uxxxx`) DM'd on each `npm run deploy` |
| `SLACK_CONNECTOR` | no | Slack Connect connector uid (default `slack/bronto-events-helper`) |
| `BRONTO_OTLP_ENDPOINT` | for tracing | e.g. `https://ingestion.eu.bronto.io` |
| `BRONTO_API_KEY` | for tracing | Bronto ingest key |
| `BRONTO_COLLECTION` / `BRONTO_DATASET` | no | Bronto routing labels (default `events-helper` / `agent-traces`) |
| `BRONTO_RECORD_IO` | no | `false` to keep prompts/outputs off the spans |

## One-time integration setup

### Persistence (Vercel Blob)

Create a Blob store in the Vercel dashboard (Storage → Blob). Add its
`BLOB_READ_WRITE_TOKEN` to the project env. The agent stores blobs **privately**, so interests
and sources are not exposed on any public URL.

### Slack (via Vercel Connect)

```bash
export FF_CONNECT_ENABLED=1
vercel connect create slack --triggers
# re-point the trigger at eve's route (the default path is not served by eve):
vercel connect detach <uid> --yes
vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
```

Put the connector UID into `agent/channels/slack.ts`, set `SLACK_DIGEST_CHANNEL_ID`, and
redeploy. Invite the bot to a channel and `@mention` it, or DM it.

> **Deployment Protection:** Vercel SSO protection must be **off** (or use an exempt custom
> domain) so Slack webhooks forwarded by Connect can reach the app —
> `vercel project protection disable --sso`. The agent still guards its own routes at the app
> layer (the Slack route verifies Vercel OIDC; the HTTP route uses an auth policy).

### Jira (via Vercel Connect)

```bash
vercel connect create mcp.atlassian.com --name atlassian
vercel connect attach <uid> --yes
```

Put the connector UID into `agent/connections/jira.ts`. Auth is **user-scoped**: the first Jira
action prompts each user to sign in to Atlassian; issue-writing actions require in-chat approval.

### Observability (Bronto)

**Traces** — set `BRONTO_OTLP_ENDPOINT` + `BRONTO_API_KEY` (and optionally collection/dataset). The
agent exports a span tree per turn (`ai.eve.turn` → model calls → tool calls) over OTLP/HTTP
protobuf. No further code needed — `agent/instrumentation.ts` is auto-discovered.

**Application logs** — the agent emits structured JSON logs (`agent/lib/log.ts`) stamped with the
active `traceId`/`spanId`, so they correlate with the spans above. They appear in Vercel's logs and,
via a log drain, in Bronto next to the traces.

**Deployment + platform logs (Vercel Drains)** — Vercel forwards runtime/build/deployment logs to
Bronto through a **Log Drain** (requires a Vercel **Pro/Enterprise** plan). Bronto documents this as
a custom-endpoint drain:

1. In Bronto, create an API key with the Ingestion role.
2. Vercel dashboard → **Team Settings → Drains → Add Drain → Logs → Custom Endpoint**.
3. Endpoint: `https://ingestion.<region>.bronto.io/` (e.g. `https://ingestion.eu.bronto.io/`).
4. Custom headers: `x-bronto-api-key: <key>`, `x-bronto-dataset: <name>`, `x-bronto-collection: <name>`.
5. Create the drain; Vercel enriches logs from traced requests with `traceId`/`spanId` automatically.

Independently, `npm run deploy` emits a **deployment log** straight to Bronto's `/v1/logs` with the
commit and change summary, so there's always a durable "deployed" event even without the drain.

## Security notes

- Secrets come from env vars only. `.env.local` and the local Blob fallback file are gitignored.
- Jira write actions are gated on human approval.
- Interest/source identity is derived from verified session auth, never from model input.
- Replace `placeholderAuth()` in `agent/channels/eve.ts` with a real auth policy before exposing a
  browser-facing web chat UI. (Not needed for Slack-only use.)

## Project scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc` — type-check the whole agent |
| `npm run deploy` | Deploy to prod + notify the operator on Slack with a change summary |
| `npm exec -- eve dev` | Interactive dev REPL |
| `npm exec -- eve dev --no-ui` | Headless dev server (HTTP API) |
| `npm run build` / `npm start` | `eve build` / `eve start` |

See [AGENTS.md](AGENTS.md) for architecture and [SUMMARY.md](SUMMARY.md) for the full build story.
