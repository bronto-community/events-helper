# Contributing to events-helper

Thanks for your interest in contributing! This is an [eve](https://eve.dev) agent; the
architecture and conventions live in [AGENTS.md](AGENTS.md) — please skim it first.

## Prerequisites

- **Node 24+** and npm
- An AI Gateway credential to run the model locally (`AI_GATEWAY_API_KEY`, or `eve link`)

## Local setup

```bash
npm install
echo 'AI_GATEWAY_API_KEY="<your-key>"' >> .env.local   # or: eve link
npm exec -- eve dev            # interactive REPL
```

Persistence falls back to a local file when `BLOB_READ_WRITE_TOKEN` is unset, so interests
and sources work offline. See [README.md](README.md) for the full environment-variable list.

## Before you open a PR

- **Type-check:** `npm run typecheck` must pass.
- **Pre-commit hook:** a husky hook runs `gitleaks` (secret scan), the type-check, and a
  docs-sync reminder. Install `gitleaks` locally for full coverage
  (<https://github.com/gitleaks/gitleaks>).
- **Keep docs in sync:** when you change behavior, setup, configuration, or the file layout,
  update the affected docs **in the same PR** — `AGENTS.md`, `README.md`,
  `docs/USER-GUIDE.md`, and `SUMMARY.md` (see the table in AGENTS.md).
- **Never commit secrets.** Credentials come from environment variables only; `.env.local`
  and the local Blob fallback file are gitignored.

## Conventions

- **NodeNext modules:** relative imports use `.js` extensions (e.g. `../lib/feeds.js`).
- **Tools:** `defineTool` + a Zod `inputSchema`; read identity/tenancy from
  `ctx.session.auth`, never from model input. Gate state-changing external actions with
  approval.
- Match the style of the surrounding code.

## Reporting bugs & ideas

Open a GitHub issue. For security reports, see [SECURITY.md](SECURITY.md) — please do **not**
file public issues for vulnerabilities.

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
