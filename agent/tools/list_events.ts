import { defineTool } from "eve/tools";
import { z } from "zod";
import { queryEventsDetailed } from "../lib/feeds.js";

export default defineTool({
  description:
    "List upcoming events (conferences, meetups) from the configured sources, sorted by soonest start date. " +
    "By default only events that have not yet started are returned. " +
    "Pass the user's interest keywords/locations (from manage_interests) to focus the list. " +
    "Listings that look like spam are filtered out automatically and reported in 'spamDropped' — " +
    "use manage_spam to review or change that.",
  inputSchema: z.object({
    keywords: z
      .array(z.string())
      .optional()
      .describe("Case-insensitive terms matched against event name, location and tags."),
    locations: z
      .array(z.string())
      .optional()
      .describe("Case-insensitive terms matched against location and country."),
    withinDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only events starting within this many days from now."),
    includePast: z
      .boolean()
      .optional()
      .describe("Include events that have already started. Default false."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max rows to return after sorting by soonest start. Default 50."),
    includeSpam: z
      .boolean()
      .optional()
      .describe(
        "Turn the spam filter off for this call, e.g. when the user asks what was filtered or " +
          "suspects something legitimate was hidden. Default false.",
      ),
  }),
  async execute(input) {
    const { events, spamDropped } = await queryEventsDetailed(input);
    return {
      count: events.length,
      events,
      spamFilteredCount: spamDropped.length,
      // Enough to name a false positive back to the user without flooding context.
      spamDropped: spamDropped.slice(0, 10).map((d) => ({ name: d.name, url: d.url, reason: d.reason })),
    };
  },
});
