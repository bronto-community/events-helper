import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { defineInstrumentation } from "eve/instrumentation";
import { DEPLOY_ATTRIBUTES } from "./lib/deploy.js";

// Exports eve/AI-SDK spans (turns, model calls, tool executions) to Bronto over
// OTLP/HTTP (protobuf). All connection details come from env vars so no secret
// or region lives in code:
//
//   BRONTO_OTLP_ENDPOINT   e.g. https://ingestion.eu.bronto.io   (region base URL)
//   BRONTO_API_KEY         your Bronto ingest key
//   BRONTO_COLLECTION      (optional) x-bronto-collection value, e.g. "events-helper"
//   BRONTO_DATASET         (optional) x-bronto-dataset value, e.g. "agent-traces"
//   BRONTO_RECORD_IO       (optional) "false" to redact prompts/outputs from spans
//
// If the endpoint or key is missing (e.g. plain `eve dev`), no exporter is
// registered and the agent runs normally without emitting telemetry.

const endpoint = process.env.BRONTO_OTLP_ENDPOINT?.replace(/\/$/, "");
const apiKey = process.env.BRONTO_API_KEY;
// eve records full message history + model outputs on spans by default. Bronto
// is an LLM-observability backend so that detail is the point; set
// BRONTO_RECORD_IO=false to redact if a session may carry sensitive content.
const recordIo = process.env.BRONTO_RECORD_IO !== "false";

export default defineInstrumentation({
  recordInputs: recordIo,
  recordOutputs: recordIo,
  setup: ({ agentName }) => {
    if (!endpoint || !apiKey) return;

    const headers: Record<string, string> = { "x-bronto-api-key": apiKey };
    if (process.env.BRONTO_COLLECTION) headers["x-bronto-collection"] = process.env.BRONTO_COLLECTION;
    if (process.env.BRONTO_DATASET) headers["x-bronto-dataset"] = process.env.BRONTO_DATASET;

    registerOTel({
      serviceName: agentName,
      // Stamp deployment provenance on every span so traces correlate with the
      // deployment log by commit / deployment id.
      attributes: Object.keys(DEPLOY_ATTRIBUTES).length > 0 ? DEPLOY_ATTRIBUTES : undefined,
      // Export each span immediately on end (SimpleSpanProcessor) instead of the
      // default batch processor. In the serverless/Workflow runtime an instance
      // can suspend before a batch flushes, dropping spans — which left some logs
      // (pushed immediately) pointing at a trace that never reached Bronto.
      spanProcessors: [
        new SimpleSpanProcessor(
          new OTLPHttpProtoTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
        ),
      ],
    });
  },
});
