import { defineHook } from "eve/hooks";
import { errorAttributes, log } from "../lib/log.js";
import { postToChannel } from "../lib/slack-notify.js";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, WARN_PCT, usagePct, usageState } from "../lib/usage.js";

// Observe token usage across the session: accumulate per-step usage, log it
// (trace-correlated via lib/log), warn the ops channel once when a session
// crosses the budget threshold, note context compactions, and alert on
// token-limit / rate-limit turn failures. All handlers are best-effort — a
// thrown hook would surface as turn.failed, so everything is wrapped.

const num = (v?: number): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const opsChannel = () => process.env.EVENTS_HELPER_DEPLOY_NOTIFY_CHANNEL;

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      try {
        const usage = event.data.usage ?? {};
        const stepIn = num(usage.inputTokens);
        const stepOut = num(usage.outputTokens);
        usageState.update((s) => ({
          ...s,
          inputTokens: s.inputTokens + stepIn,
          outputTokens: s.outputTokens + stepOut,
          totalTokens: s.totalTokens + stepIn + stepOut,
          steps: s.steps + 1,
        }));
        const s = usageState.get();
        const pct = usagePct(s);
        log.info("token usage", {
          "eve.session.id": ctx.session.id,
          // per-step usage → GenAI semconv (matches the AI SDK spans)
          "gen_ai.usage.input_tokens": stepIn,
          "gen_ai.usage.output_tokens": stepOut,
          // cumulative session totals + budget → project namespace
          "events_helper.session.steps": s.steps,
          "events_helper.session.input_tokens": s.inputTokens,
          "events_helper.session.output_tokens": s.outputTokens,
          "events_helper.session.token_budget_pct": pct,
        });
        if (pct >= WARN_PCT && s.alertedPct < WARN_PCT) {
          usageState.update((x) => ({ ...x, alertedPct: pct }));
          log.warn("token budget threshold reached", {
            "eve.session.id": ctx.session.id,
            "events_helper.session.token_budget_pct": pct,
          });
          const ch = opsChannel();
          if (ch) {
            await postToChannel(
              ch,
              `⚠️ events-helper session \`${ctx.session.id}\` is at ~${pct}% of its token budget ` +
                `(${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out; ` +
                `caps ${MAX_INPUT_TOKENS.toLocaleString()}/${MAX_OUTPUT_TOKENS.toLocaleString()}).`,
            );
          }
        }
      } catch (err) {
        log.warn("usage hook step.completed failed", errorAttributes(err));
      }
    },

    "compaction.requested"(event, ctx) {
      try {
        usageState.update((s) => ({ ...s, compactions: s.compactions + 1 }));
        log.info("context compaction", {
          "eve.session.id": ctx.session.id,
          "gen_ai.usage.input_tokens": event.data.usageInputTokens ?? undefined,
        });
      } catch (err) {
        log.warn("usage hook compaction.requested failed", errorAttributes(err));
      }
    },

    async "turn.failed"(event, ctx) {
      try {
        const { code, message } = event.data;
        log.error("turn failed", {
          "eve.session.id": ctx.session.id,
          "error.type": code,
          "events_helper.error.detail": message,
        });
        const ch = opsChannel();
        if (ch && typeof code === "string" && /TOKEN_LIMIT|RATE|QUOTA|429/i.test(code)) {
          await postToChannel(
            ch,
            `🚫 events-helper session \`${ctx.session.id}\` failed: ${code}${message ? ` — ${message}` : ""}`,
          );
        }
      } catch (err) {
        log.warn("usage hook turn.failed failed", errorAttributes(err));
      }
    },
  },
});
