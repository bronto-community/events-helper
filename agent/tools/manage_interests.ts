import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  getGlobal,
  getPersonal,
  resolveEffective,
  setGlobal,
  setPersonal,
  type GlobalInterests,
  type PersonalInterests,
} from "../lib/interests.js";
import { callerId, isAdmin, isSuperAdmin, roleOf, rolesConfigured } from "../lib/roles.js";
import { isSubscribed, setSubscribed } from "../lib/alerts.js";
import { log } from "../lib/log.js";

export default defineTool({
  description:
    "Read or update interest profiles. There are two layers:\n" +
    "- GLOBAL: team-wide keywords/locations/notes (admin-managed); also drives the weekly digest.\n" +
    "- PERSONAL: the current user's overlay — it inherits global, can ADD personal interests, and " +
    "can EXCLUDE specific global items (e.g. the user says 'I don't care about Kubernetes').\n\n" +
    "Actions:\n" +
    "- 'get': returns the caller's effective interests (use these to filter list_cfps/list_events), " +
    "plus the raw global and personal layers and the caller's id.\n" +
    "- 'set_global': replace the global profile (admins only). Use when an admin sets team interests.\n" +
    "- 'set_personal': replace the CALLER's overlay. To append, call 'get' first, merge, then set the " +
    "full overlay back. Put excluded global topics in excludeKeywords/excludeLocations.\n" +
    "- 'subscribe' / 'unsubscribe': opt the caller in/out of the daily personal CfP alert DMs " +
    "(matched to their effective interests). Use when the user asks to (un)subscribe to CfP alerts/reminders.",
  inputSchema: z.object({
    action: z.enum(["get", "set_global", "set_personal", "subscribe", "unsubscribe"]),
    global: z
      .object({
        keywords: z.array(z.string()).default([]),
        locations: z.array(z.string()).default([]),
        notes: z.string().default(""),
      })
      .optional()
      .describe("Required for 'set_global'."),
    personal: z
      .object({
        addKeywords: z.array(z.string()).default([]),
        addLocations: z.array(z.string()).default([]),
        excludeKeywords: z.array(z.string()).default([]),
        excludeLocations: z.array(z.string()).default([]),
        notes: z.string().default(""),
      })
      .optional()
      .describe("Required for 'set_personal'. Replaces the caller's entire overlay."),
  }),
  async execute(input, ctx) {
    const { id, isUser } = callerId(ctx);

    if (input.action === "set_global") {
      if (!isAdmin(id)) {
        log.warn("unauthorized set_global attempt", {
          "user.id": id,
          "user.roles": [roleOf(id)],
        });
        throw new Error(
          "Only admins may set the global interest profile. Ask an admin, or configure EVENTS_HELPER_ADMIN_IDS.",
        );
      }
      if (!input.global) throw new Error("'global' is required for action 'set_global'.");
      const next: GlobalInterests = input.global;
      await setGlobal(next);
      log.info("global interests updated", {
        "user.id": id,
        "events_helper.interests.keyword_count": next.keywords.length,
        "events_helper.interests.location_count": next.locations.length,
      });
      return { updated: "global", global: next, rolesConfigured: rolesConfigured() };
    }

    if (input.action === "set_personal") {
      if (!input.personal) throw new Error("'personal' is required for action 'set_personal'.");
      const next: PersonalInterests = input.personal;
      await setPersonal(id, next);
      log.info("personal interests updated", {
        "user.id": id,
        "events_helper.interests.added_count": next.addKeywords.length + next.addLocations.length,
        "events_helper.interests.excluded_count":
          next.excludeKeywords.length + next.excludeLocations.length,
      });
      const effective = resolveEffective(await getGlobal(), next);
      return { updated: "personal", you: id, isUser, personal: next, effective };
    }

    if (input.action === "subscribe" || input.action === "unsubscribe") {
      const subscribed = input.action === "subscribe";
      await setSubscribed(id, subscribed);
      log.info("alert subscription changed", {
        "user.id": id,
        "events_helper.alerts.subscribed": subscribed,
      });
      return { you: id, subscribed };
    }

    // get
    const [global, personal, subscribed] = await Promise.all([
      getGlobal(),
      getPersonal(id),
      isSubscribed(id),
    ]);
    const effective = resolveEffective(global, personal);
    return {
      you: id,
      isUser,
      role: roleOf(id),
      isAdmin: isAdmin(id),
      isSuperAdmin: isSuperAdmin(id),
      rolesConfigured: rolesConfigured(),
      subscribedToAlerts: subscribed,
      global,
      personal,
      effective,
    };
  },
});
