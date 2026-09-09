import { defineTool } from "eve/tools";
import { z } from "zod";
import { queryEventsDetailed } from "../lib/feeds.js";
import { log } from "../lib/log.js";
import { callerId, isAdmin } from "../lib/roles.js";
import {
  SPAM_FILTER_ENABLED,
  addRules,
  getSpamReport,
  listRules,
  removeRule,
  summarizeDropped,
  type NewSpamRule,
  type RuleMatch,
} from "../lib/spam.js";

// The spam filter runs by itself on every event read; this tool is the control
// surface over it: see what it dropped and why, block something for good, or
// allow a false positive back in.

const MATCHES: [RuleMatch, ...RuleMatch[]] = ["event_id", "title", "organizer", "url_host", "source"];

export default defineTool({
  description:
    "Inspect and steer the team-wide event spam filter. The filter runs automatically on every " +
    "event read (list_events, the digest, the daily scan, per-user alerts): it drops listings that " +
    "look like junk — the same thing cross-posted to many calendars, an online session advertised " +
    "under a city, ticket-selling / course-selling wording — and stays applied on every future run. " +
    "Actions: 'report' (what the last full scan filtered, with reasons), 'preview' (classify live " +
    "events right now and show what would be dropped), 'list_rules', 'block' (never show this again), " +
    "'allow' (a false positive — pin it back into view; allow beats block), 'unblock' (delete a rule " +
    "by id). Rules are shared by the whole team; 'block'/'allow'/'unblock' require admin. " +
    "A 'block' on a title also catches the same listing re-posted elsewhere or on another date. " +
    "This filter covers events only, not CfPs.",
  inputSchema: z.object({
    action: z.enum(["report", "preview", "list_rules", "block", "allow", "unblock"]),
    match: z
      .enum(MATCHES)
      .optional()
      .describe(
        "What to match for 'block'/'allow': 'event_id' (one listing), 'title' (matched as a " +
          "normalized substring — use for recurring junk), 'organizer' (one spammy host), " +
          "'url_host', or 'source' (a whole feed). Defaults to 'event_id'.",
      ),
    value: z
      .string()
      .optional()
      .describe("The value to match — required for 'block'/'allow' (e.g. the event url/id or its title)."),
    reason: z.string().optional().describe("Why, for the audit trail (e.g. 'paid online course cross-posted')."),
    ruleId: z.string().optional().describe("Rule id to delete — required for 'unblock'."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max rows for 'report'/'preview'. Default 25."),
  }),
  async execute(input, ctx) {
    const { id: actor } = callerId(ctx);
    const limit = input.limit ?? 25;

    switch (input.action) {
      case "report": {
        const report = await getSpamReport();
        return {
          enabled: SPAM_FILTER_ENABLED,
          report: report
            ? {
                at: new Date(report.at).toISOString(),
                total: report.total,
                counts: report.counts,
                dropped: report.sample.slice(0, limit),
              }
            : null,
          note: report
            ? "From the last full source scan. Something legitimate in here? Use action 'allow' with its url as the value."
            : "No spam report yet — it is written by the daily source scan (or run rescan_sources now).",
        };
      }

      case "preview": {
        // Re-run the classification with nothing hidden, so the caller sees the
        // current verdicts rather than a stored snapshot.
        const { spamDropped } = await queryEventsDetailed({ limit: 5000 });
        return {
          enabled: SPAM_FILTER_ENABLED,
          total: spamDropped.length,
          summary: summarizeDropped(spamDropped),
          dropped: spamDropped.slice(0, limit),
        };
      }

      case "list_rules": {
        const rules = await listRules();
        return {
          enabled: SPAM_FILTER_ENABLED,
          count: rules.length,
          rules: rules.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
        };
      }

      case "block":
      case "allow": {
        if (!isAdmin(actor)) {
          throw new Error(
            "Only admins can change the shared spam rules. A regular user can still use the " +
              "'Not interested' button on an alert card to mute something just for themselves.",
          );
        }
        if (!input.value) throw new Error(`'value' is required for action '${input.action}'.`);
        const rule: NewSpamRule = {
          kind: input.action === "block" ? "block" : "allow",
          match: input.match ?? "event_id",
          value: input.value,
          reason: input.reason,
        };
        const { rules, added } = await addRules([rule], actor, Date.now());
        log.info("spam rule requested", {
          "user.id": actor,
          "events_helper.spam.rule_kind": rule.kind,
          "events_helper.spam.rule_match": rule.match,
          "events_helper.spam.rules_added": added.length,
        });
        return {
          added,
          alreadyPresent: added.length === 0,
          ruleCount: rules.length,
          effect:
            rule.kind === "block"
              ? "Dropped from every future list, digest, scan and alert."
              : "Pinned back into view — allow beats both the heuristics and any block rule.",
        };
      }

      case "unblock": {
        if (!isAdmin(actor)) throw new Error("Only admins can change the shared spam rules.");
        if (!input.ruleId) throw new Error("'ruleId' is required for action 'unblock'.");
        const { removed, rules } = await removeRule(input.ruleId, actor);
        if (!removed) throw new Error(`No spam rule with id '${input.ruleId}'. Use 'list_rules' to see them.`);
        return { removed, ruleCount: rules.length };
      }
    }
  },
});
