import { getToken } from "@vercel/connect";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { adminIds, callerId, roleOf, rolesConfigured, superAdminIds } from "../lib/roles.js";

// Best-effort: resolve `slack:<team>:<Uxxxx>` principals to display names via the
// Slack API (needs the users:read scope). Falls back to ids if unavailable.
async function resolveNames(principals: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const userIds = principals
    .map((p) => p.split(":").pop() ?? "")
    .filter((u) => u.startsWith("U"));
  if (userIds.length === 0) return names;
  try {
    const token = await getToken(process.env.SLACK_CONNECTOR || "slack/bronto-events-helper", {
      subject: { type: "app" },
    });
    await Promise.all(
      principals.map(async (principal) => {
        const userId = principal.split(":").pop() ?? "";
        if (!userId.startsWith("U")) return;
        const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await res.json()) as {
          ok: boolean;
          user?: { real_name?: string; name?: string; profile?: { real_name?: string } };
        };
        if (body.ok && body.user) {
          const name = body.user.profile?.real_name || body.user.real_name || body.user.name;
          if (name) names.set(principal, name);
        }
      }),
    );
  } catch {
    // best effort — no token / scope / network: return whatever we have
  }
  return names;
}

export default defineTool({
  description:
    "Report roles and permissions for this bot: who the super admins (operators) and admins are, " +
    "and the caller's own role. Use this for ANY question about admins, super admins, operators, " +
    "permissions, or 'who can change the global settings / who runs the bot'. Do not claim you lack " +
    "visibility into roles — call this tool.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { id, isUser } = callerId(ctx);
    const supers = superAdminIds();
    const admins = adminIds();
    const names = await resolveNames([...new Set([...supers, ...admins, id])]);
    const withNames = (ids: string[]) => ids.map((p) => ({ id: p, name: names.get(p) ?? null }));
    return {
      you: { id, isUser, role: roleOf(id), name: names.get(id) ?? null },
      rolesConfigured: rolesConfigured(),
      superAdmins: withNames(supers),
      admins: withNames(admins),
      note: rolesConfigured()
        ? "Super admins are also admins (a superset). Admins can change the global interest profile; super admins are the operators and receive deploy notifications."
        : "No roles are configured yet — everyone is treated as an admin (bootstrap mode).",
    };
  },
});
