import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  SEED_SOURCES,
  addSource,
  getAllSources,
  getCustomSources,
  removeSource,
} from "../lib/sources.js";
import { backend } from "../lib/store.js";
import { callerId } from "../lib/roles.js";
import { log } from "../lib/log.js";
import { OCGROUPS_ENABLED } from "../lib/ocgroups.js";
import { ICAL_ENABLED, toIcalUrl, validateIcal } from "../lib/ical.js";

export default defineTool({
  description:
    "List, add, or remove event/CfP feed sources (a shared team catalog). Three source kinds: " +
    "'cfps' and 'events' are HTTPS URLs returning a JSON array in the developers.events format; " +
    "'ical' is any iCalendar (.ics) feed and produces events. To watch a Meetup group, add an " +
    "'ical' source and pass the group's page URL (e.g. https://www.meetup.com/berlindroid/) or " +
    "'meetup:<slug>' as the url — it's resolved to the group's calendar feed automatically, and " +
    "validated on add (private groups without a public calendar are rejected). Use the optional " +
    "'location' to label where a group meets (helps location filters) and 'tags' for topics. " +
    "Use 'add' for sources you discovered while hunting the web (with web_search / web_fetch); " +
    "added sources persist across sessions. Built-in sources cannot be removed.",
  inputSchema: z.object({
    action: z.enum(["list", "add", "remove"]),
    source: z
      .object({
        id: z.string().min(1).describe("Stable slug, unique across all sources."),
        name: z.string().min(1),
        url: z
          .string()
          .min(1)
          .describe("Feed URL. For 'ical' you may pass a Meetup group URL or 'meetup:<slug>'."),
        kind: z.enum(["cfps", "events", "ical"]),
        location: z
          .string()
          .optional()
          .describe("Optional location label applied to every event from this source (e.g. 'Berlin')."),
        tags: z.array(z.string()).optional().describe("Optional topic tags for every event from this source."),
      })
      .optional()
      .describe("Required for 'add'."),
    id: z.string().optional().describe("Source id to remove. Required for 'remove'."),
  }),
  async execute(input, ctx) {
    const { id: actor } = callerId(ctx);
    switch (input.action) {
      case "list": {
        const custom = await getCustomSources();
        return {
          persistence: backend,
          seed: SEED_SOURCES,
          custom,
          icalEnabled: ICAL_ENABLED,
          icalSources: custom.filter((s) => s.kind === "ical"),
          // Built-in providers that aren't plain JSON feeds:
          providers: OCGROUPS_ENABLED
            ? [
                {
                  name: "Open Community Groups (ocgroups.dev)",
                  kind: "events",
                  note: "CNCF community-group events via its JSON search endpoint; cached to avoid overloading the platform.",
                },
              ]
            : [],
        };
      }
      case "add": {
        if (!input.source) throw new Error("'source' is required for action 'add'.");
        const source = { ...input.source };
        let validated: { upcoming: number } | undefined;
        if (source.kind === "ical") {
          source.url = toIcalUrl(source.url);
          const check = await validateIcal(source.url);
          if (!check.ok) {
            throw new Error(
              `Could not read the iCal feed at ${source.url} (${check.error}). ` +
                "If this is a Meetup group, its calendar may be private (members-only feeds " +
                "return an invalid-signature error and can't be watched).",
            );
          }
          validated = { upcoming: check.upcoming };
        }
        const custom = await addSource(source);
        log.info("feed source added", {
          "user.id": actor,
          "events_helper.source.id": source.id,
          "events_helper.source.kind": source.kind,
          "url.full": source.url,
        });
        return { added: source, resolvedUrl: source.url, validated, custom };
      }
      case "remove": {
        if (!input.id) throw new Error("'id' is required for action 'remove'.");
        const custom = await removeSource(input.id);
        log.info("feed source removed", {
          "user.id": actor,
          "events_helper.source.id": input.id,
        });
        return { removed: input.id, custom };
      }
      default:
        return { sources: await getAllSources() };
    }
  },
});
