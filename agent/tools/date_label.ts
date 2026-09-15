import { defineTool } from "eve/tools";
import { z } from "zod";
import { dateRangeLabel, withWeekday } from "../lib/dates.js";

// Every date in a message carries its weekday, and the weekday is always computed
// here rather than by the model — date arithmetic is something it does confidently
// and occasionally wrongly, and a wrong weekday beside a right date looks
// authoritative. The CfP/event tools already attach labels to what they return;
// this tool covers everything else a date can arrive from: a Jira issue, a web
// page, the user's own message.
export default defineTool({
  description:
    "Add the weekday to dates that did not come from another tool's label — e.g. a date read from a " +
    "Jira issue, a web page, or the user's message. Returns each input as a ready-to-print label " +
    "(`2026-09-18` → `Fri 2026-09-18`; a pair of dates becomes a range, `Mon 2027-03-15 → Thu " +
    "2027-03-18`). Call it instead of working a weekday out yourself, and print what it returns " +
    "verbatim. Dates from list_cfps / list_events already carry their labels — use those directly.",
  inputSchema: z.object({
    dates: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        "ISO dates to label, e.g. ['2026-09-18']. Use 'YYYY-MM-DD'; a full timestamp is read in UTC.",
      ),
    asRange: z
      .boolean()
      .optional()
      .describe(
        "True to fold the dates into one range label (first → last), for an event that runs over " +
          "several days. Default false: each date is labelled on its own.",
      ),
  }),
  execute(input) {
    if (input.asRange) return { label: dateRangeLabel(input.dates) };
    return {
      labels: input.dates.map((date) => ({ date, label: withWeekday(date) })),
    };
  },
});
