import { trace } from "@opentelemetry/api";
import { DEPLOY_ATTRIBUTES } from "./deploy.js";

// Structured, trace-correlated logging. Each line is JSON and carries the active
// OpenTelemetry trace/span id, so logs line up with the spans we already export
// to Bronto (ai.eve.turn → tool calls).
//
// Two delivery paths:
//  1. console.* — always. Shows in the eve dev REPL and in Vercel's logs.
//  2. Direct OTLP push to Bronto /v1/logs — when BRONTO_OTLP_ENDPOINT + BRONTO_API_KEY
//     are set. This makes logs appear in Bronto WITHOUT a Vercel log drain (which
//     needs a Vercel Pro plan). Once a Vercel→Bronto log drain is live, set
//     BRONTO_DIRECT_LOGS=false to avoid duplicate log lines in Bronto.
//
// The push is best-effort and fire-and-forget: it never blocks or fails a tool.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogAttributes = Record<string, unknown>;

const SERVICE = "events-helper";
const BRONTO_ENDPOINT = process.env.BRONTO_OTLP_ENDPOINT?.replace(/\/$/, "");
const BRONTO_KEY = process.env.BRONTO_API_KEY;
const BRONTO_DIRECT =
  Boolean(BRONTO_ENDPOINT && BRONTO_KEY) && process.env.BRONTO_DIRECT_LOGS !== "false";

// OpenTelemetry log severity numbers.
const SEVERITY: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 };

function otlpAnyValue(v: unknown): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(otlpAnyValue) } };
  if (v === null || v === undefined) return { stringValue: "" };
  return { stringValue: JSON.stringify(v) };
}

function shipToBronto(
  level: LogLevel,
  message: string,
  attributes: LogAttributes | undefined,
  spanContext: { traceId: string; spanId: string } | undefined,
): void {
  if (!BRONTO_DIRECT) return;
  const attrs = Object.entries({ "service.name": SERVICE, ...(attributes ?? {}) })
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: otlpAnyValue(v) }));
  const logRecord: Record<string, unknown> = {
    timeUnixNano: String(Date.now() * 1_000_000),
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: { stringValue: message },
    attributes: attrs,
    // OTLP/JSON encodes trace_id/span_id as hex strings — which is exactly the
    // form SpanContext exposes, so Bronto correlates logs to spans natively.
    ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-bronto-api-key": BRONTO_KEY ?? "",
  };
  if (process.env.BRONTO_COLLECTION) headers["x-bronto-collection"] = process.env.BRONTO_COLLECTION;
  if (process.env.BRONTO_DATASET) headers["x-bronto-dataset"] = process.env.BRONTO_DATASET;
  const resourceAttrs = [
    { key: "service.name", value: { stringValue: SERVICE } },
    ...Object.entries(DEPLOY_ATTRIBUTES).map(([key, v]) => ({ key, value: { stringValue: v } })),
  ];
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [{ scope: { name: SERVICE }, logRecords: [logRecord] }],
      },
    ],
  };
  void fetch(`${BRONTO_ENDPOINT}/v1/logs`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }).catch(() => {
    /* best-effort: never let telemetry break the agent */
  });
}

function emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
  const spanContext = trace.getActiveSpan()?.spanContext();
  const record: Record<string, unknown> = {
    level,
    message,
    "service.name": SERVICE,
    ...DEPLOY_ATTRIBUTES,
    ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
    ...attributes,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  shipToBronto(level, message, attributes, spanContext);
}

export const log = {
  debug: (message: string, attributes?: LogAttributes) => emit("debug", message, attributes),
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};

/**
 * Semantic-convention attributes for a caught error: `error.type` (a low-cardinality
 * class, per OTel — `error.message` is deprecated) plus the variable detail under the
 * project namespace. Spread into a log's attributes: `log.warn("x failed", errorAttributes(err))`.
 */
export function errorAttributes(err: unknown): LogAttributes {
  return {
    "error.type": err instanceof Error ? err.name : typeof err,
    "events_helper.error.detail": err instanceof Error ? err.message : String(err),
  };
}
