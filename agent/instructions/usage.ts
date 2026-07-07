import { defineDynamic, defineInstructions } from "eve/instructions";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, usagePct, usageState } from "../lib/usage.js";

// Make the agent aware of its own token usage so it can proactively warn the
// user as a conversation grows. Resolves each turn from the durable per-session
// usage state (updated by agent/hooks/usage.ts). Skipped on the first turn,
// when there's nothing to report.
export default defineDynamic({
  events: {
    "turn.started"() {
      const s = usageState.get();
      if (s.steps === 0) return null;
      const pct = usagePct(s);
      return defineInstructions({
        markdown:
          `Token budget (this conversation): ~${s.inputTokens.toLocaleString()} input + ` +
          `${s.outputTokens.toLocaleString()} output tokens used, about ${pct}% of the session ` +
          `budget (${MAX_INPUT_TOKENS.toLocaleString()} in / ${MAX_OUTPUT_TOKENS.toLocaleString()} out). ` +
          `If this is 80% or higher, briefly tell the user the conversation is getting large and ` +
          `suggest starting a fresh thread. If a token-limit error occurs, explain it and ask them ` +
          `to start a new thread.`,
      });
    },
  },
});
