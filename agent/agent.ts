import { defineAgent } from "eve";

// The model is configurable at runtime via the EVE_MODEL environment variable
// (a Vercel AI Gateway id such as "anthropic/claude-sonnet-5" or
// "anthropic/claude-opus-4.8"). Change it without touching code by setting
// EVE_MODEL in your environment / Vercel project settings. eve resolves this
// once when the agent module loads, so a restart/redeploy picks up the change.
export default defineAgent({
  model: process.env.EVE_MODEL || "anthropic/claude-sonnet-5",
});
