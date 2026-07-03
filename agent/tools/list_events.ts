import { defineTool } from "eve/tools";
import { z } from "zod";
import { queryEvents } from "../lib/feeds.js";

export default defineTool({
  description:
    "List upcoming events (conferences, meetups) from the configured sources, sorted by soonest start date. " +
    "By default only events that have not yet started are returned. " +
    "Pass the user's interest keywords/locations (from manage_interests) to focus the list.",
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
  }),
  async execute(input) {
    const events = await queryEvents(input);
    return { count: events.length, events };
  },
});
