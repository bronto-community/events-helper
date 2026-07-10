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

export default defineTool({
  description:
    "List, add, or remove event/CfP feed sources. Feeds must be HTTPS URLs returning a JSON array " +
    "in the developers.events format. Use 'add' to incorporate a new source you discovered while " +
    "hunting the web (with web_search / web_fetch); added sources persist across sessions. " +
    "Built-in sources cannot be removed.",
  inputSchema: z.object({
    action: z.enum(["list", "add", "remove"]),
    source: z
      .object({
        id: z.string().min(1).describe("Stable slug, unique across all sources."),
        name: z.string().min(1),
        url: z.string().url(),
        kind: z.enum(["cfps", "events"]),
      })
      .optional()
      .describe("Required for 'add'."),
    id: z.string().optional().describe("Source id to remove. Required for 'remove'."),
  }),
  async execute(input, ctx) {
    const { id: actor } = callerId(ctx);
    switch (input.action) {
      case "list": {
        return {
          persistence: backend,
          seed: SEED_SOURCES,
          custom: await getCustomSources(),
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
        const custom = await addSource(input.source);
        log.info("feed source added", {
          "user.id": actor,
          "events_helper.source.id": input.source.id,
          "events_helper.source.kind": input.source.kind,
          "url.full": input.source.url,
        });
        return { added: input.source, custom };
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
