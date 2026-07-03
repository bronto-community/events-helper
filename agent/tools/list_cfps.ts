import { defineTool } from "eve/tools";
import { z } from "zod";
import { queryCfps } from "../lib/feeds.js";

export default defineTool({
  description:
    "List open Call-for-Papers (CfPs) from the configured sources, sorted by soonest deadline. " +
    "By default only CfPs whose deadline is still in the future are returned. " +
    "Use this to answer 'what CfPs are coming up' — pass the user's interest keywords/locations " +
    "(read them with manage_interests) to narrow results to what they care about.",
  inputSchema: z.object({
    keywords: z
      .array(z.string())
      .optional()
      .describe("Case-insensitive terms matched against event name and location."),
    locations: z
      .array(z.string())
      .optional()
      .describe("Case-insensitive terms matched against the event location."),
    withinDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only CfPs whose deadline is within this many days from now."),
    includePast: z
      .boolean()
      .optional()
      .describe("Include CfPs whose deadline has already passed. Default false."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max rows to return after sorting by soonest deadline. Default 50."),
  }),
  async execute(input) {
    const cfps = await queryCfps(input);
    return { count: cfps.length, cfps };
  },
});
