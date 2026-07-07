import { defineState } from "eve/context";

// Per-session token-usage awareness. A hook accumulates provider-reported usage
// from `step.completed`; dynamic instructions surface it to the model; the agent
// enforces a session ceiling via defineAgent({ limits }). All bounds are
// env-tunable so they can be adjusted without a code change.

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  steps: number;
  compactions: number;
  /** Highest budget-% threshold we've already alerted on (avoids repeat alerts per session). */
  alertedPct: number;
}

export const usageState = defineState("events-helper.usage", (): UsageState => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  steps: 0,
  compactions: 0,
  alertedPct: 0,
}));

// Session ceilings (provider-reported cumulative tokens). Generous defaults so
// normal long-lived Slack threads don't trip them; tune via env. eve fails the
// next model call with SESSION_TOKEN_LIMIT_REACHED once a ceiling is crossed.
export const MAX_INPUT_TOKENS = Number(process.env.EVE_MAX_INPUT_TOKENS) || 10_000_000;
export const MAX_OUTPUT_TOKENS = Number(process.env.EVE_MAX_OUTPUT_TOKENS) || 1_000_000;
/** Percent of a ceiling at which to warn (log + ops alert). */
export const WARN_PCT = Number(process.env.EVE_TOKEN_WARN_PCT) || 80;

/** Usage as a percent of the nearest ceiling (max of input% and output%). */
export function usagePct(s: UsageState): number {
  const inPct = MAX_INPUT_TOKENS > 0 ? (s.inputTokens / MAX_INPUT_TOKENS) * 100 : 0;
  const outPct = MAX_OUTPUT_TOKENS > 0 ? (s.outputTokens / MAX_OUTPUT_TOKENS) * 100 : 0;
  return Math.round(Math.max(inPct, outPct));
}
