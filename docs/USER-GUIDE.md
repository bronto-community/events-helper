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

### Roles

- **Everyone** can manage their own personal interests and query CfPs/events.
- **Admins** can set the shared **global** profile (and thus the digest):
  > Set the team interests to Kubernetes, observability, and platform engineering, in Europe.
  Non-admins are politely refused.
- **Super admins / operators** are a superset of admins with extra responsibilities — for
  example, they get a Slack notification (with a change summary) whenever the bot is redeployed.

Ask **"what's my id?"** and the bot tells you your principal id and role — that's what an operator
adds to the admin / super-admin lists. You can also ask **"who are the admins?"** or **"who runs
this bot?"** and the bot lists the super admins and admins (by name where it can resolve them).

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

## Personal alerts (opt-in)

Want your own daily heads-up? Tell the bot **"subscribe me to alerts"** and it'll DM you each day
with:

- the **CfPs** matching *your* interests that are newly found or closing soon, and
- **newly-announced events** matching your interests — for example when a watched Meetup group posts
  a new event.

Each is an interactive card. On a **CfP** card: **Submit ↗** (opens the submission page),
**Not interested** (never alert me about this CfP again), **Snooze** (mute it for a while). On an
**event** card: **View ↗**, **Not interested**, **Snooze**.

To file a CfP as a Jira issue, just **reply in the DM** (e.g. "file the KubeCon CfP to Jira"). Say
**"unsubscribe from alerts"** to stop the daily DMs. Event alerts only cover things announced
*after* you subscribe, so you won't get a flood of the existing backlog.

## Managing sources

The bot reads from the [developers.events](https://developers.events) CfP and event feeds, and
from CNCF [Open Community Groups](https://ocgroups.dev) (community-group meetups), by default.
Sources are **shared across the team**. If something's missing:

> Can you find a feed for security conference CfPs and add it?

The bot searches the web, checks the feed looks right, and adds it to the shared catalog so
everyone benefits. You can also ask "what sources are configured?" or "remove the X source."

### Watching a Meetup group

To keep an eye on a specific Meetup group, just give the bot its page URL:

> Watch the Berlin Android meetup: https://www.meetup.com/berlindroid/ — it's in Berlin

The bot subscribes to that group's official calendar feed and adds it as a shared source. From then
on its upcoming events show up in "list events," the digest, and the team's daily scan (new events
are flagged in the ops channel), and — if you're subscribed to alerts — you'll get a DM when the
group announces a new event that matches your interests. Tell it the group's **city** (Meetup
calendars often don't include a venue) so location filters work. Private, members-only groups can't
be watched (their calendar isn't public) — the bot will tell you if that's the case. The same works
for any public calendar (`.ics`) feed, not just Meetup.

## Tips

- Deadlines move fast — ask fresh rather than trusting an old message; the bot re-checks live.
- Be specific: "CfPs closing within 2 weeks for data engineering, online only" works great.
- Location matching is keyword-based, so "Germany" or a city matches better than a broad region.
  If a broad term misses things, the bot will broaden automatically and tell you.
