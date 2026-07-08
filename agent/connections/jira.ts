import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// Atlassian's official remote MCP server exposes Jira (and Confluence) tools:
// create/read/update issues, transitions, comments, links, JQL search, etc.
// The model discovers them via `connection_search` and calls them as
// `jira__<tool>` (e.g. jira__createJiraIssue, jira__transitionJiraIssue).
//
// Auth runs through Vercel Connect (user-scoped OAuth). Provision a connector
// with `vercel connect create mcp.atlassian.com --name atlassian` and set
// JIRA_CONNECTOR to its UID. The first Jira tool call emits an OAuth link for
// the user to sign in.
const JIRA_CONNECTOR = process.env.JIRA_CONNECTOR || "mcp.atlassian.com/atlassian";

// Gate anything that can change Jira state; let reads/searches through.
const MUTATION_HINTS = [
  "create",
  "edit",
  "update",
  "add",
  "transition",
  "delete",
  "remove",
  "link",
  "assign",
  "move",
];

export default defineMcpClientConnection({
  url: "https://mcp.atlassian.com/v1/sse",
  description:
    "Atlassian Jira: create issues to track a CfP, then read, comment on, update, and transition " +
    "them. Also supports JQL search over existing issues.",
  auth: connect(JIRA_CONNECTOR),
  // Custom policy: MCP tool names arrive qualified (jira__createJiraIssue), so
  // match the bare name with .includes(). Writes need human approval; reads run
  // freely.
  approval: ({ toolName }) => {
    const bare = toolName.toLowerCase();
    return MUTATION_HINTS.some((h) => bare.includes(h)) ? "user-approval" : "not-applicable";
  },
});
