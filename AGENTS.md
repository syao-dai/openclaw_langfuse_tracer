Telegraph style. Scoped to this submodule (own git repo: `syao-dai/openclaw_langfuse_tracer`, vendored into the main `openclaw` fork at `submodules/langfuse_tracer`).

## What this is

OpenClaw plugin. `openclaw.plugin.json` + `package.json#openclaw.extensions` load `dist/index.js`, which calls `setupLangfuseTracer(api)` from `src/tracer.ts`. Registers hooks (`before_agent_start`, `llm_input`/`llm_output`, `before_tool_call`/`after_tool_call`, `agent_iteration_start/end`, `before_compaction`/`after_compaction`, `agent_end`) to assemble one Langfuse trace per agent run and, on `agent_end`, POST it as an OTLP/JSON `ExportTraceServiceRequest` to `POST {baseUrl}/api/public/otel/v1/traces`.

## Ingestion protocol: OTLP/JSON, not the legacy batch-item API

The self-hosted Langfuse backend this plugin talks to is on v4 with `LANGFUSE_MIGRATION_V4_WRITE_MODE=dual` (previously briefly `events_only`). In `events_only` mode the old `/api/public/ingestion` batch endpoint (`trace-create`/`generation-create`/`span-create` items) silently rejects everything except `score-create`/`sdk-log` — confirmed via a server-side log line (`Rejected N event(s) ... because this Langfuse v4 deployment runs in events_only mode`) — while `fetch`'s `res.ok` still reads `true` because the endpoint replies HTTP 207. `dual` mode still accepts the old shape (via a ~15min-delayed staging pipeline) but that's a stopgap, not the target. Per Langfuse's "Migrate custom ingestion to Langfuse v4" guide, this plugin now sends proper OTLP instead:

- **Endpoint**: `POST {baseUrl}/api/public/otel/v1/traces` (same `baseUrl`/`Authorization` as before, just a different path).
- **Encoding**: OTLP/**JSON** (never protobuf — no OTel SDK, no protobuf lib; hand-rolled JSON per the OTLP spec keeps the zero-npm-dependency constraint). Every attribute value is a typed `AnyValue` wrapper object (`{"stringValue": "..."}`, `{"intValue": "..."}`, `{"doubleValue": ...}`, `{"boolValue": ...}`, `{"arrayValue": {"values": [...]}}`) — NOT the flat-object shorthand some Langfuse doc examples use for illustration.
- **Headers**: `Authorization` (unchanged Basic auth from `trace.credentials.authHeader`), `Content-Type: application/json`, `x-langfuse-ingestion-version: 4` (now meaningful, since this is the real OTel path).
- **No more trace-create**: a Langfuse "trace" is now implicit from one shared OTel `traceId` across every span belonging to that agent run — `AgentTrace.traceId` (and `GenerationRecord.generationId`/`IterationRecord.iterationId`/`CompactionRecord.compactionId`/`SpanRecord.spanId`) are generated as OTel-valid hex ids (`newTraceId()`: 32 hex chars / `newSpanId()`: 16 hex chars, via `node:crypto`'s `randomBytes`) and used directly as `traceId`/`spanId`/`parentSpanId` — they are no longer opaque UUIDs.
- **Span tree**: `agent_end` builds one synthetic root span (`langfuse.observation.type = "agent"`, name `openclaw-agent-run`) carrying the trace-level input/output, and every generation/iteration/compaction/tool-call span is parented to it (or, for tool calls, to the generation/iteration span they occurred under) via real `parentSpanId` — replacing the old `parentObservationId` field.
- **Trace-level attributes copied onto every span**: `langfuse.user.id`, `langfuse.session.id`, `langfuse.trace.name`, `langfuse.trace.tags` (array), `langfuse.trace.metadata.<key>` — Langfuse v4 requires these on each span to stay queryable, not just set once on a root object. Built once per `agent_end` call by `buildTraceLevelAttributes()` and spread into every span's `attributes`.
- **Per-observation attributes**: `langfuse.observation.type` (`generation`/`tool`/`span`/`agent`/...), `langfuse.observation.input`/`.output` (stringified JSON, replacing the old `body.input`/`body.output`), plus `langfuse.observation.metadata.<key>` for anything else.
- **Generation-specific**: model name on both `gen_ai.request.model` and `langfuse.observation.model.name`; token usage as `langfuse.observation.usage_details` (a JSON-string attribute — confirmed key/shape from Langfuse's migration guide) plus redundant `gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens` (OTel GenAI semconv names). **Open question**: the sub-key names used inside the `usage_details` JSON blob for cache tokens (`cache_read_input_tokens`/`cache_creation_input_tokens`, mirrored from this plugin's existing `usage.cacheRead`/`cacheWrite` fields) are a best-effort guess, not independently confirmed against Langfuse's docs — verify in the Langfuse UI if cache token display looks wrong. No cost tracking exists in this plugin's data model, so `langfuse.observation.cost_details` is not sent.
- **Timestamps**: `startTimeUnixNano`/`endTimeUnixNano` as **strings** (not numbers — avoids JS number precision loss for nanosecond epoch values), converted straight from the ms-epoch numbers already stored (`Date.now()`) via `toUnixNano()`.

## Build

No local `typescript` install here. From this dir: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json` (uses the main `openclaw` repo's `node_modules`). `tsconfig.json` has `noEmitOnError: false`, so it still emits working `dist/**/*.js` even though `tsc` reports errors outside the Docker container:
- `TS2307` on `openclaw/plugin-sdk/plugin-entry` — that module only resolves inside the container where this repo is mounted at `/openclaw` and the real `openclaw` package is installed.
- `TS7006` implicit-any on hook `event`/`eventCtx` params — same cause, pre-existing, not a regression signal.

After editing `src/tracer.ts`: rebuild, then sanity-check with `node --check dist/src/tracer.js` and `git diff -w` to confirm only your intended lines changed (not just reformatting noise).

## Invariant: never call `JSON.stringify(x).slice(...)` directly on span/generation/iteration data

`JSON.stringify(undefined)` returns the JS value `undefined`, not a string — `.slice()` on that throws `TypeError: Cannot read properties of undefined (reading 'slice')`. `span.input`/`span.output` are `undefined` whenever a tool call's `before_tool_call` fired but `after_tool_call` never did — i.e. the run was aborted/killed while that tool call was in flight. This crashed the `agent_end` handler synchronously, before the batch ever reached `fetch()`, silently dropping the *entire* trace (generations/iterations that had already completed included) for every killed run that had an in-flight tool call. Confirmed in `dev_env/openclaw_logs/openclaw-2026-08-28.log`: 2 of 8 aborted runs that day lost their trace this way (`[hooks] agent_end handler from langfuse-tracer failed: Cannot read properties of undefined (reading 'slice')`).

Fix: always serialize through `safeStringifySlice()` (falls back to `"null"` instead of throwing). New span/generation/iteration fields that can be `undefined` need the same treatment — don't reintroduce a bare `JSON.stringify(...).slice(...)`.

## Design decision: killed spans are flagged, not dropped

`buildToolCallSpan()` marks a span with no `endTime` (never got `after_tool_call`, i.e. killed mid-call) with `langfuse.observation.output: "[killed] ..."`, OTel span `status: {code: 2 (ERROR), message: "killed: ..."}`, and `langfuse.observation.metadata.killed: true` — visible in Langfuse for debugging instead of vanishing. Do not "simplify" this back to unconditionally serializing `span.output`; a killed trace is still debugging value.

## Design decision: span-tree-build try/catch always sends something

The `agent_end` handler wraps the OTel span-tree construction (root span + generations + iterations + compactions + tool-call spans) in `try/catch`. On any unexpected serialization failure it falls back to a minimal single root span (still `langfuse.observation.type: "agent"`) tagged `batch-build-error` in `langfuse.trace.tags` rather than losing the trace outright, and cleanup (`activeTraces`/`activeGenerations`/`activeIterations` deletion) always runs after, whether the try succeeded or not. Keep that ordering when touching this block — cleanup must not depend on the span tree having built successfully.
