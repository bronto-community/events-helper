# events-helper — User Guide

events-helper is a Slack bot that helps you find **conference Call for Papers (CfPs)** and
events worth your time, track them in **Jira**, and get a weekly heads-up of what's coming up.

You talk to it in plain language — there's no config file or form to fill in.

## Getting started

- **In a channel:** invite the bot (`/invite @events-helper`) and `@mention` it.
- **In a DM:** just message it directly.

Try:

> @events-helper what CfPs are coming up?

It reads your interests, pulls the latest open CfPs, and lists them by soonest deadline.

## Finding CfPs and events

Ask naturally. Examples:

- "What CfPs close in the next 30 days?"
- "Any Kubernetes CfPs in Europe?"
- "Show me upcoming conferences in Germany."
- "What observability events are happening online this year?"

Each CfP comes back with the **submission deadline** (and how many days are left), the event
name, location, and the link to submit. The bot only reports real entries from its sources — it
won't invent deadlines or links.

## Telling it what you care about (interests)

Interests have two layers:

- **Global** — a team-wide profile (topics + locations) that everyone starts from. Only admins
  change it. It also drives the weekly digest.
- **Personal** — your own overlay on top of global. You can **add** topics and **exclude** global
  topics you don't care about.

Your **effective** interests = everything in global, plus your additions, minus your exclusions.

Say things like:

- "I'm interested in Rust and WebAssembly." → adds them for you
- "I don't care about Kubernetes." → excludes it for you (even if it's global)
- "I only want events in Europe or online." → sets your preferred locations
- "What are my interests?" → shows global, your personal overlay, and the effective result

Your interests are private to you and persist across conversations. Changing them never affects
anyone else.

### For admins

If you're an admin you can set the shared baseline:

> Set the team interests to Kubernetes, observability, and platform engineering, in Europe.

That updates the **global** profile (and what the weekly digest looks for). Non-admins are
politely refused. Ask "what's my id?" if an admin needs to add you to the admin list.

## Tracking a CfP in Jira

When you want to act on a CfP:

> File the KubeCon EU CfP as a Jira issue in project CONF.

The bot drafts a clean issue (title, deadline, event dates, links) and — because creating/editing
Jira is a real change — asks you to **approve** before it writes. The first time, it'll give you a
link to sign in to Atlassian with your own account. Afterwards you can:

- "Add a comment to that issue: drafting a talk on eBPF."
- "Move CONF-142 to In Progress."
- "What CfP issues are still open?"

## The weekly digest

Once a week the bot posts a digest of upcoming CfPs that match the **global** interests to a
designated Slack channel — a shared team heads-up. If nothing matches, it stays quiet. (Admins
configure which channel; see the README.)

## Managing sources

The bot reads from the [developers.events](https://developers.events) CfP and event feeds by
default. Sources are **shared across the team**. If something's missing:

> Can you find a feed for security conference CfPs and add it?

The bot searches the web, checks the feed looks right, and adds it to the shared catalog so
everyone benefits. You can also ask "what sources are configured?" or "remove the X source."

## Tips

- Deadlines move fast — ask fresh rather than trusting an old message; the bot re-checks live.
- Be specific: "CfPs closing within 2 weeks for data engineering, online only" works great.
- Location matching is keyword-based, so "Germany" or a city matches better than a broad region.
  If a broad term misses things, the bot will broaden automatically and tell you.
