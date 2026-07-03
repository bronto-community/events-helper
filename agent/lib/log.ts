import { trace } from "@opentelemetry/api";

// Structured, trace-correlated logging. Each line is JSON and carries the active
// OpenTelemetry trace/span id, so logs line up with the spans we already export
// to Bronto (ai.eve.turn → tool calls). On Vercel these go to the platform logs
// and, via a Bronto log drain, into Bronto alongside the traces.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogAttributes = Record<string, unknown>;

const SERVICE = "events-helper";

function emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
  const spanContext = trace.getActiveSpan()?.spanContext();
  const record: Record<string, unknown> = {
    level,
    message,
    service: SERVICE,
    ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
    ...attributes,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, attributes?: LogAttributes) => emit("debug", message, attributes),
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};
