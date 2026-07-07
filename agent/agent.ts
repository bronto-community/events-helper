import { defineAgent } from "eve";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from "./lib/usage.js";

// The model is configurable at runtime via the EVE_MODEL environment variable
// (a Vercel AI Gateway id such as "anthropic/claude-sonnet-5" or
// "anthropic/claude-opus-4.8"). Change it without touching code by setting
// EVE_MODEL in your environment / Vercel project settings. eve resolves this
// once when the agent module loads, so a restart/redeploy picks up the change.
export default defineAgent({
  model: process.env.EVE_MODEL || "anthropic/claude-sonnet-5",
  // Per-session token ceilings (env-tunable via EVE_MAX_INPUT_TOKENS /
  // EVE_MAX_OUTPUT_TOKENS). Once crossed, the next model call fails with
  // SESSION_TOKEN_LIMIT_REACHED. The usage hook logs running totals and alerts
  // the ops channel at EVE_TOKEN_WARN_PCT before the hard stop.
  limits: {
    maxInputTokensPerSession: MAX_INPUT_TOKENS,
    maxOutputTokensPerSession: MAX_OUTPUT_TOKENS,
  },
});
