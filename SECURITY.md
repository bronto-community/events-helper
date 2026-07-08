# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" under
  the repository's **Security** tab), or
- Email **security@bronto.io**.

Include a description, reproduction steps, and impact. We'll acknowledge your report, keep you
updated on the fix, and credit you if you'd like once a fix ships.

## Scope & handling secrets

This project keeps all credentials in environment variables — never in the repository. If you
believe a secret has been committed, report it privately as above.

For deployers: review the [README](README.md) security notes before exposing the agent. In
particular, replace `placeholderAuth()` on the HTTP channel with a real auth policy before any
browser-facing use, keep Jira/other write actions gated on approval, and scope connection
credentials to least privilege.
