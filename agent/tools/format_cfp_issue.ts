import { defineTool } from "eve/tools";
import { z } from "zod";

// Turns a CfP into a ready-to-file Jira issue payload. This does NOT touch Jira
// itself — it just composes clean, consistent fields. After calling it, pass the
// returned `summary` / `description` / `labels` to the Jira create tool
// (jira__createJiraIssue) along with the project key and issue type.
export default defineTool({
  description:
    "Compose a ready-to-file Jira issue payload from a Call-for-Papers. Returns a summary, a " +
    "formatted description (deadline, event dates, location, links), and suggested labels. Use it " +
    "before jira__createJiraIssue so tracked CfPs are consistent and actionable. It does not create " +
    "the issue itself.",
  inputSchema: z.object({
    event: z.string().min(1).describe("Event / conference name."),
    deadline: z
      .string()
      .optional()
      .describe("CfP submission deadline (ISO date, e.g. 2026-08-15)."),
    daysUntilDeadline: z
      .number()
      .int()
      .optional()
      .describe("Days until the deadline, if known."),
    eventDates: z
      .array(z.string())
      .optional()
      .describe("ISO date(s) the event runs."),
    location: z.string().optional(),
    cfpUrl: z.string().optional().describe("Where to submit the talk."),
    eventUrl: z.string().optional().describe("The event's website."),
    notes: z.string().optional().describe("Anything else to record on the issue."),
    labels: z
      .array(z.string())
      .optional()
      .describe("Extra labels to add beyond the defaults."),
  }),
  execute(input) {
    const deadlineLine = input.deadline
      ? `${input.deadline}${
          typeof input.daysUntilDeadline === "number"
            ? ` (${input.daysUntilDeadline} days left)`
            : ""
        }`
      : "unknown";

    const lines = [
      `Call for Papers for ${input.event}.`,
      "",
      `- Submission deadline: ${deadlineLine}`,
    ];
    if (input.eventDates?.length) lines.push(`- Event dates: ${input.eventDates.join(", ")}`);
    if (input.location) lines.push(`- Location: ${input.location}`);
    if (input.cfpUrl) lines.push(`- Submit CfP: ${input.cfpUrl}`);
    if (input.eventUrl) lines.push(`- Event site: ${input.eventUrl}`);
    if (input.notes) lines.push("", input.notes);

    const summary = input.deadline
      ? `CfP: ${input.event} — submit by ${input.deadline}`
      : `CfP: ${input.event}`;

    const labels = Array.from(new Set(["cfp", "conference", ...(input.labels ?? [])]));

    return { summary, description: lines.join("\n"), labels };
  },
});
