Telegraph style. Scoped to this submodule (own git repo: `syao-dai/openclaw_langfuse_tracer`, vendored into the main `openclaw` fork at `submodules/langfuse_tracer`).

## What this is

OpenClaw plugin. `openclaw.plugin.json` + `package.json#openclaw.extensions` load `dist/index.js`, which calls `setupLangfuseTracer(api)` from `src/tracer.ts`. Registers hooks (`before_agent_start`, `llm_input`/`llm_output`, `before_tool_call`/`after_tool_call`, `agent_iteration_start/end`, `before_compaction`/`after_compaction`, `agent_end`) to assemble one Langfuse trace per agent run and POST it to `/api/public/ingestion` on `agent_end`.

## Build

No local `typescript` install here. From this dir: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json` (uses the main `openclaw` repo's `node_modules`). `tsconfig.json` has `noEmitOnError: false`, so it still emits working `dist/**/*.js` even though `tsc` reports errors outside the Docker container:
- `TS2307` on `openclaw/plugin-sdk/plugin-entry` — that module only resolves inside the container where this repo is mounted at `/openclaw` and the real `openclaw` package is installed.
- `TS7006` implicit-any on hook `event`/`eventCtx` params — same cause, pre-existing, not a regression signal.

After editing `src/tracer.ts`: rebuild, then sanity-check with `node --check dist/src/tracer.js` and `git diff -w` to confirm only your intended lines changed (not just reformatting noise).

## Invariant: never call `JSON.stringify(x).slice(...)` directly on span/generation/iteration data

`JSON.stringify(undefined)` returns the JS value `undefined`, not a string — `.slice()` on that throws `TypeError: Cannot read properties of undefined (reading 'slice')`. `span.input`/`span.output` are `undefined` whenever a tool call's `before_tool_call` fired but `after_tool_call` never did — i.e. the run was aborted/killed while that tool call was in flight. This crashed the `agent_end` handler synchronously, before the batch ever reached `fetch()`, silently dropping the *entire* trace (generations/iterations that had already completed included) for every killed run that had an in-flight tool call. Confirmed in `dev_env/openclaw_logs/openclaw-2026-08-28.log`: 2 of 8 aborted runs that day lost their trace this way (`[hooks] agent_end handler from langfuse-tracer failed: Cannot read properties of undefined (reading 'slice')`).

Fix: always serialize through `safeStringifySlice()` (falls back to `"null"` instead of throwing). New span/generation/iteration fields that can be `undefined` need the same treatment — don't reintroduce a bare `JSON.stringify(...).slice(...)`.

## Design decision: killed spans are flagged, not dropped

`buildSpanBatchItem()` marks a span with no `endTime` (never got `after_tool_call`, i.e. killed mid-call) with `output: "[killed] ..."`, `level: "WARNING"`, `metadata.killed: true` — visible in Langfuse for debugging instead of vanishing. Do not "simplify" this back to unconditionally serializing `span.output`; a killed trace is still debugging value.

## Design decision: batch-build try/catch always sends something

The `agent_end` handler wraps trace/generation/iteration/span batch construction in `try/catch`. On any unexpected serialization failure it falls back to a minimal `trace-create` record tagged `batch-build-error` rather than losing the trace outright, and cleanup (`activeTraces`/`activeGenerations`/`activeIterations` deletion) always runs after, whether the try succeeded or not. Keep that ordering when touching this block — cleanup must not depend on the batch having built successfully.
