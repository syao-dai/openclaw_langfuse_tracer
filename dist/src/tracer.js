import { randomBytes } from "node:crypto";
function extractText(content, maxLen) {
    if (typeof content === "string") {
        return content.slice(0, maxLen);
    }
    if (Array.isArray(content)) {
        return content
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
            .slice(0, maxLen);
    }
    return "";
}
// OTel requires valid hex trace/span IDs (16 bytes / 8 bytes). These replace the
// old crypto.randomUUID()-based ids everywhere an id doubles as an OTel
// traceId/spanId (trace.traceId, generation/iteration/compaction/tool-span ids) —
// no new dependency, node:crypto's randomBytes is a Node builtin.
function newTraceId() {
    return randomBytes(16).toString("hex");
}
function newSpanId() {
    return randomBytes(8).toString("hex");
}
function attrStr(key, value) {
    if (!value)
        return undefined;
    return { key, value: { stringValue: value } };
}
function attrInt(key, value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return undefined;
    return { key, value: { intValue: String(Math.trunc(value)) } };
}
function attrBool(key, value) {
    if (typeof value !== "boolean")
        return undefined;
    return { key, value: { boolValue: value } };
}
function attrStrArray(key, values) {
    if (!values || values.length === 0)
        return undefined;
    return { key, value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } };
}
function compactAttrs(attrs) {
    return attrs.filter((a) => a !== undefined);
}
// Nanosecond-precision unix timestamp as a string, per OTLP/JSON spec (avoids JS
// number precision loss for large nanosecond values). Inputs are the ms-epoch
// numbers this plugin already stores (Date.now()).
function toUnixNano(msEpoch) {
    return (BigInt(Math.round(msEpoch)) * 1000000n).toString();
}
// Trace-level concepts (user/session/trace name/tags/custom metadata) have no
// separate "trace" object anymore under OTLP — Langfuse v4 requires them to be
// copied onto every span that needs to be queryable by them, so this is spread
// into every span's attributes below rather than set once on a root object.
function buildTraceLevelAttributes(params) {
    const attrs = [
        attrStr("langfuse.user.id", params.agentId),
        attrStr("langfuse.session.id", params.sessionKey),
        attrStr("langfuse.trace.name", params.traceName),
        attrStrArray("langfuse.trace.tags", params.tags),
    ];
    for (const [k, v] of Object.entries(params.metadata)) {
        if (v === undefined || v === null)
            continue;
        if (typeof v === "number") {
            attrs.push(attrInt(`langfuse.trace.metadata.${k}`, v));
        }
        else if (typeof v === "boolean") {
            attrs.push(attrBool(`langfuse.trace.metadata.${k}`, v));
        }
        else {
            attrs.push(attrStr(`langfuse.trace.metadata.${k}`, String(v)));
        }
    }
    return compactAttrs(attrs);
}
// Token usage, as Langfuse's own `langfuse.observation.usage_details` JSON-string
// attribute (confirmed key name/shape via Langfuse's v4 OTel migration guide).
// Sub-key names here (cache_read_input_tokens/cache_creation_input_tokens) mirror
// this plugin's existing usage fields but are NOT independently confirmed against
// Langfuse's docs for what it expects inside that JSON blob — see AGENTS.md note.
function usageDetailsAttribute(usage) {
    if (!usage)
        return undefined;
    const details = {};
    if (typeof usage.input === "number")
        details.input = usage.input;
    if (typeof usage.output === "number")
        details.output = usage.output;
    if (typeof usage.total === "number")
        details.total = usage.total;
    if (typeof usage.cacheRead === "number")
        details.cache_read_input_tokens = usage.cacheRead;
    if (typeof usage.cacheWrite === "number")
        details.cache_creation_input_tokens = usage.cacheWrite;
    if (Object.keys(details).length === 0)
        return undefined;
    return attrStr("langfuse.observation.usage_details", JSON.stringify(details));
}
// gen_ai.usage.input_tokens/output_tokens are the standard OTel GenAI semantic
// convention attribute names — added as redundant, independently-recognizable
// usage signals alongside usage_details above (belt-and-suspenders, since which
// one Langfuse's OTel ingest actually reads for UI display wasn't independently
// verified beyond the migration guide's mention of "usage" attributes).
function genAiUsageAttributes(usage) {
    return compactAttrs([
        attrInt("gen_ai.usage.input_tokens", usage?.input),
        attrInt("gen_ai.usage.output_tokens", usage?.output),
    ]);
}
// JSON.stringify(undefined) returns the JS value `undefined`, not a string — calling
// .slice() on that throws. Tool calls that never received an after_tool_call (because
// the run was aborted/killed mid-call) leave span.input/output as `undefined`, so every
// call site that serializes them needs this instead of a bare JSON.stringify(...).slice(...).
function safeStringifySlice(value, maxLen, fallback = "null") {
    let str;
    try {
        str = JSON.stringify(value) ?? fallback;
    }
    catch {
        str = fallback;
    }
    return str.slice(0, maxLen);
}
// Builds the OTel span for one tool call. Shared by generation-level and
// iteration-level spans. A span with no endTime never received after_tool_call — the run
// was aborted/killed while the tool was in flight — so it's flagged rather than dropped,
// since a killed trace is still valuable for debugging.
function buildToolCallSpan(span, parentSpanId, traceId, nowMs, dataLimits, sharedAttrs) {
    const killed = !span.endTime;
    let output;
    if (span.error) {
        output = `ERROR: ${span.error}`;
    }
    else if (killed) {
        output = "[killed] run was aborted/terminated before this tool call completed";
    }
    else {
        output = safeStringifySlice(span.output, dataLimits.toolResult);
    }
    const durationMs = typeof span.metadata?.durationMs === "number" ? span.metadata.durationMs : undefined;
    const attributes = compactAttrs([
        ...sharedAttrs,
        attrStr("langfuse.observation.type", "tool"),
        attrStr("langfuse.observation.input", safeStringifySlice(span.input, dataLimits.toolParams)),
        attrStr("langfuse.observation.output", output),
        attrStr("langfuse.observation.metadata.toolCallId", span.toolCallId),
        attrInt("langfuse.observation.metadata.durationMs", durationMs),
        killed ? attrBool("langfuse.observation.metadata.killed", true) : undefined,
    ]);
    return {
        traceId,
        spanId: span.spanId,
        parentSpanId,
        name: span.toolName,
        startTimeUnixNano: toUnixNano(span.startTime),
        endTimeUnixNano: toUnixNano(span.endTime ?? nowMs),
        attributes,
        status: span.error
            ? { code: 2, message: span.error }
            : killed
                ? { code: 2, message: "killed: run aborted before tool call completed" }
                : { code: 1 },
    };
}
/**
 * OpenClaw can re-invoke a plugin's setup() mid-session (e.g. when a subagent
 * spawn forces a plugin registry reload) without the process restarting. A
 * plain module-level `new Map()` would silently reset on that re-invocation
 * and orphan any trace created before the reload. Symbol.for() keys resolve
 * through the global symbol registry, so the same Map instance is reused
 * across setup() calls within one process even though a fresh module closure
 * runs each time.
 */
function resolveGlobalMap(key) {
    const globalStore = globalThis;
    const symbolKey = Symbol.for(key);
    const existing = globalStore[symbolKey];
    if (existing instanceof Map) {
        return existing;
    }
    const created = new Map();
    globalStore[symbolKey] = created;
    return created;
}
export function setupLangfuseTracer(api) {
    const pluginConfig = (api.pluginConfig ?? {});
    // Setup logging
    const logLevel = pluginConfig.logLevel ?? "info";
    const isDebug = logLevel === "debug";
    const debug = (message) => {
        if (isDebug)
            api.logger.info(message);
    };
    // Read credentials from plugin config. `credentials` is a list of Langfuse
    // projects, each optionally scoped to a set of agent IDs; the legacy
    // `langfuse` object (if present) is folded in as the catch-all group so
    // existing single-project configs keep working unchanged.
    const defaultBaseUrl = "http://172.21.0.1:3050";
    const isValidGroup = (group) => Boolean(group?.publicKey?.trim() && group?.secretKey?.trim());
    const credentialGroups = (Array.isArray(pluginConfig.credentials) ? pluginConfig.credentials : []).filter(isValidGroup);
    const hasExplicitCatchAll = credentialGroups.some((group) => !group.agentIds || group.agentIds.length === 0);
    if (!hasExplicitCatchAll && isValidGroup(pluginConfig.langfuse)) {
        credentialGroups.push(pluginConfig.langfuse);
    }
    if (credentialGroups.length === 0) {
        api.logger.info("[langfuse-tracer] Langfuse credentials not configured. " +
            "Configure via openclaw.json, e.g.:\n" +
            "  openclaw config set plugins.entries.langfuse-tracer.config.credentials " +
            "'[{\"publicKey\":\"pk-lf-xxx\",\"secretKey\":\"sk-lf-xxx\",\"baseUrl\":\"http://langfuse:3000\"}]'\n" +
            "— tracing disabled");
        return;
    }
    const authHeaderCache = new Map();
    const resolveCredentials = (agentId) => {
        const group = (agentId && credentialGroups.find((g) => g.agentIds?.includes(agentId))) ||
            credentialGroups.find((g) => !g.agentIds || g.agentIds.length === 0);
        if (!group) {
            return null;
        }
        const key = `${group.publicKey}:${group.secretKey}`;
        let authHeader = authHeaderCache.get(key);
        if (!authHeader) {
            authHeader = "Basic " + Buffer.from(key).toString("base64");
            authHeaderCache.set(key, authHeader);
        }
        return {
            baseUrl: (group.baseUrl?.trim() ?? defaultBaseUrl).replace(/\/$/, ""),
            authHeader,
        };
    };
    api.logger.info(`[langfuse-tracer] Configured ${credentialGroups.length} Langfuse credential group(s): ` +
        credentialGroups
            .map((g, i) => g.agentIds && g.agentIds.length > 0
            ? `#${i + 1}[agents: ${g.agentIds.join(", ")}]`
            : `#${i + 1}[default/catch-all]`)
            .join(", "));
    // Parse data limits from plugin config with defaults
    const dataLimits = {
        userInput: pluginConfig.limits?.userInput ?? 2000,
        assistantOutput: pluginConfig.limits?.assistantOutput ?? 10000,
        systemPrompt: pluginConfig.limits?.systemPrompt ?? 20000,
        history: pluginConfig.limits?.history ?? 5000,
        toolParams: pluginConfig.limits?.toolParams ?? 500,
        toolResult: pluginConfig.limits?.toolResult ?? 1000,
    };
    api.logger.info(`[langfuse-tracer] Data limits: ` +
        `user=${dataLimits.userInput}, ` +
        `assistant=${dataLimits.assistantOutput}, ` +
        `system=${dataLimits.systemPrompt}, ` +
        `history=${dataLimits.history}, ` +
        `toolParams=${dataLimits.toolParams}, ` +
        `toolResult=${dataLimits.toolResult}`);
    // Parse tracked agents configuration
    let trackedAgents = null; // null = track all agents
    if (Array.isArray(pluginConfig.trackedAgents) && pluginConfig.trackedAgents.length > 0) {
        trackedAgents = new Set(pluginConfig.trackedAgents);
        api.logger.info(`[langfuse-tracer] Tracking specific agents: ${Array.from(trackedAgents).join(", ")}`);
    }
    else {
        api.logger.info("[langfuse-tracer] Tracking all agents");
    }
    if (isDebug) {
        api.logger.info(`[langfuse-tracer] Debug mode enabled`);
    }
    // Store active agent traces keyed by session key
    const activeTraces = resolveGlobalMap("openclaw.langfuse-tracer.activeTraces");
    // Store current generation for each runId
    const activeGenerations = resolveGlobalMap("openclaw.langfuse-tracer.activeGenerations");
    // Store current iteration for each runId
    const activeIterations = resolveGlobalMap("openclaw.langfuse-tracer.activeIterations");
    // Store pending tool calls keyed by runId+toolCallId
    const pendingToolCalls = resolveGlobalMap("openclaw.langfuse-tracer.pendingToolCalls");
    // Store compaction context for each session
    const pendingCompactions = resolveGlobalMap("openclaw.langfuse-tracer.pendingCompactions");
    api.on("before_agent_start", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] before_agent_start: ` +
            `agentId=${eventCtx.agentId}, sessionKey=${eventCtx.sessionKey}, ` +
            `prompt=${event.prompt?.slice(0, 100)}...`);
        // Filter: only track specified agents if trackedAgents is configured
        if (trackedAgents !== null && eventCtx.agentId && !trackedAgents.has(eventCtx.agentId)) {
            debug(`[langfuse-tracer] [DEBUG] Skipping agent ${eventCtx.agentId} (not in trackedAgents)`);
            return;
        }
        const credentials = resolveCredentials(eventCtx.agentId);
        if (!credentials) {
            debug(`[langfuse-tracer] [DEBUG] No Langfuse credential group matches agent ` +
                `${eventCtx.agentId} (and no default/catch-all group configured), skipping trace`);
            return;
        }
        const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
        const traceId = newTraceId();
        // Create a new trace for this agent run
        const trace = {
            traceId,
            agentId: eventCtx.agentId,
            sessionKey: eventCtx.sessionKey,
            userInput: event.prompt ?? "",
            startTime: Date.now(),
            generations: [],
            iterations: [],
            compactions: [],
            credentials,
        };
        activeTraces.set(key, trace);
        debug(`[langfuse-tracer] [DEBUG] Created trace ${traceId} for ${key}`);
    });
    // Capture LLM input - start a new Generation observation
    api.on("llm_input", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] llm_input: ` +
            `runId=${event.runId}, model=${event.model}, provider=${event.provider}`);
        const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
        const trace = activeTraces.get(key);
        if (!trace) {
            debug(`[langfuse-tracer] [DEBUG] No active trace for ${key}, skipping generation`);
            return;
        }
        const generationId = newSpanId();
        // 🏷️ Build structured JSON input for Langfuse parsing
        const inputData = {};
        // INITIAL_SYSTEM_PROMPT as JSON key
        if (event.systemPrompt) {
            inputData.INITIAL_SYSTEM_PROMPT = event.systemPrompt.slice(0, dataLimits.systemPrompt);
        }
        // INITIAL_HISTORY as JSON key
        if (event.historyMessages && event.historyMessages.length > 0) {
            inputData.INITIAL_HISTORY = {
                messageCount: event.historyMessages.length,
                messages: event.historyMessages,
            };
        }
        // USER_PROMPT as JSON key
        if (event.prompt) {
            inputData.USER_PROMPT = event.prompt.slice(0, dataLimits.userInput);
        }
        // Convert to formatted JSON string
        let inputStr;
        try {
            inputStr = JSON.stringify(inputData, null, 2);
        }
        catch (err) {
            // Fallback if stringify fails
            inputStr = JSON.stringify({
                error: "Failed to serialize input",
                prompt: event.prompt?.slice(0, 100),
            });
        }
        const generation = {
            generationId,
            runId: event.runId,
            model: event.model,
            provider: event.provider,
            systemPrompt: event.systemPrompt,
            historyMessages: event.historyMessages,
            startTime: Date.now(),
            input: inputStr,
            spans: [],
        };
        activeGenerations.set(event.runId, generation);
        trace.generations.push(generation);
        debug(`[langfuse-tracer] [DEBUG] Created generation ${generationId} for trace ${trace.traceId}`);
    });
    // Capture LLM output - complete the Generation observation
    api.on("llm_output", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] llm_output: ` +
            `runId=${event.runId}, usage=${JSON.stringify(event.usage)}`);
        const generation = activeGenerations.get(event.runId);
        if (!generation) {
            debug(`[langfuse-tracer] [DEBUG] No active generation for runId ${event.runId}`);
            return;
        }
        // Complete the generation with output and usage
        generation.endTime = Date.now();
        generation.output = event.assistantTexts.join("\n").slice(0, dataLimits.assistantOutput);
        generation.usage = event.usage;
        debug(`[langfuse-tracer] [DEBUG] Completed generation ${generation.generationId}, ` +
            `duration=${generation.endTime - generation.startTime}ms, ` +
            `spans=${generation.spans.length}`);
    });
    // Capture tool calls - create Span observations nested under the current Generation or Iteration
    api.on("before_tool_call", (event, toolCtx) => {
        debug(`[langfuse-tracer] [DEBUG] before_tool_call: ` +
            `runId=${event.runId}, tool=${event.toolName}`);
        // Try to attach to active iteration first (for iteration 2+)
        const iteration = event.runId ? activeIterations.get(event.runId) : null;
        const generation = event.runId ? activeGenerations.get(event.runId) : null;
        if (!iteration && !generation) {
            debug(`[langfuse-tracer] [DEBUG] No active iteration or generation for ` +
                `tool call ${event.toolName}`);
            return;
        }
        const spanId = newSpanId();
        const spanKey = `${event.runId}:${event.toolCallId ?? spanId}`;
        const span = {
            spanId,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            startTime: Date.now(),
            input: event.params,
        };
        pendingToolCalls.set(spanKey, span);
        // Attach to iteration if exists (iteration 2+), otherwise to generation (iteration 1)
        if (iteration) {
            iteration.spans.push(span);
            debug(`[langfuse-tracer] [DEBUG] Created span ${spanId} (${event.toolName}) ` +
                `under iteration ${iteration.iterationId}`);
        }
        else if (generation) {
            generation.spans.push(span);
            debug(`[langfuse-tracer] [DEBUG] Created span ${spanId} (${event.toolName}) ` +
                `under generation ${generation.generationId} (iteration 1)`);
        }
    });
    api.on("after_tool_call", (event, toolCtx) => {
        debug(`[langfuse-tracer] [DEBUG] after_tool_call: ` +
            `runId=${event.runId}, tool=${event.toolName}, durationMs=${event.durationMs}`);
        const spanKey = `${event.runId}:${event.toolCallId ?? ""}`;
        const span = pendingToolCalls.get(spanKey);
        if (!span) {
            debug(`[langfuse-tracer] [DEBUG] No pending span for ${spanKey}`);
            return;
        }
        // Complete the span
        span.endTime = Date.now();
        span.output = event.result;
        span.error = event.error;
        span.metadata = {
            durationMs: event.durationMs,
        };
        pendingToolCalls.delete(spanKey);
        debug(`[langfuse-tracer] [DEBUG] Completed span ${span.spanId} (${event.toolName}), ` +
            `duration=${event.durationMs}ms`);
    });
    // 🔥 Capture agent_iteration_start - beginning of each LLM iteration
    api.on("agent_iteration_start", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] agent_iteration_start: ` +
            `runId=${event.runId}, iterationId=${event.iterationId}, ` +
            `messages=${event.messages?.length ?? 0}`);
        const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
        const trace = activeTraces.get(key);
        if (!trace) {
            debug(`[langfuse-tracer] [DEBUG] No active trace for ${key}, skipping iteration_start`);
            return;
        }
        const iterationId = newSpanId();
        // Extract last 2 messages from history
        const recentMessages = Array.isArray(event.messages) && event.messages.length > 0
            ? event.messages.slice(-2)
            : [];
        const iteration = {
            iterationId,
            runId: event.runId,
            iterationNumber: event.iterationId,
            startTime: Date.now(),
            toolResults: event.toolResults,
            recentMessages,
            spans: [],
        };
        activeIterations.set(event.runId, iteration);
        trace.iterations.push(iteration);
        debug(`[langfuse-tracer] [DEBUG] Created iteration ${iterationId} ` +
            `(#${event.iterationId}) for trace ${trace.traceId}`);
    });
    // 🔥 Capture agent_iteration_end - completion of each LLM iteration
    api.on("agent_iteration_end", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] agent_iteration_end: ` +
            `runId=${event.runId}, iterationId=${event.iterationId}, ` +
            `toolCalls=${event.toolCalls?.length ?? 0}`);
        let iteration = activeIterations.get(event.runId);
        // Special case: iteration 1 without agent_iteration_start
        // Don't create separate iteration record, merge with generation instead
        if (!iteration && event.iterationId === 1) {
            debug(`[langfuse-tracer] [DEBUG] Iteration 1 without start event, ` +
                `merging output with generation`);
            const generation = activeGenerations.get(event.runId);
            if (generation) {
                // Build structured JSON output for Langfuse parsing
                const outputData = {};
                // ASSISTANT_OUTPUT as JSON key
                if (event.assistantMessage) {
                    outputData.ASSISTANT_OUTPUT = event.assistantMessage;
                }
                // TOOL_CALLS_PLANNED as JSON key
                if (event.toolCalls && event.toolCalls.length > 0) {
                    outputData.TOOL_CALLS_PLANNED = event.toolCalls;
                }
                // Convert to formatted JSON string
                try {
                    generation.output = JSON.stringify(outputData, null, 2);
                }
                catch (err) {
                    // Fallback if stringify fails
                    generation.output = `{"error": "Failed to serialize output", "toolCalls": ${event.toolCalls?.length ?? 0}}`;
                }
                generation.usage = event.usage; // Update with actual usage
                generation.endTime = Date.now();
                debug(`[langfuse-tracer] [DEBUG] Merged iteration 1 output into generation ` +
                    `${generation.generationId}, toolCalls=${event.toolCalls?.length ?? 0}`);
            }
            return;
        }
        // Normal case: iteration 2+
        if (!iteration) {
            debug(`[langfuse-tracer] [DEBUG] No active iteration for runId ${event.runId}`);
            return;
        }
        // Complete the iteration
        iteration.endTime = Date.now();
        iteration.assistantMessage = event.assistantMessage;
        iteration.toolCalls = event.toolCalls;
        iteration.usage = event.usage;
        debug(`[langfuse-tracer] [DEBUG] Completed iteration ${iteration.iterationId}, ` +
            `duration=${iteration.endTime - iteration.startTime}ms, ` +
            `toolCalls=${event.toolCalls?.length ?? 0}`);
    });
    // 🔥 Capture before_compaction - context is about to be compressed
    api.on("before_compaction", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] before_compaction: ` +
            `sessionKey=${eventCtx.sessionKey}, messageCount=${event.messageCount}`);
        const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
        const trace = activeTraces.get(key);
        if (!trace) {
            debug(`[langfuse-tracer] [DEBUG] No active trace for ${key}, skipping compaction`);
            return;
        }
        const compactionId = newSpanId();
        const compaction = {
            compactionId,
            startTime: Date.now(),
            messageCountBefore: event.messageCount,
            // Capture a snapshot of current state before compaction
            systemPromptBefore: event.systemPrompt?.slice(0, dataLimits.systemPrompt),
            historyBefore: event.messages,
        };
        pendingCompactions.set(key, compaction);
        trace.compactions.push(compaction);
        debug(`[langfuse-tracer] [DEBUG] Started compaction ${compactionId} for trace ${trace.traceId}`);
    });
    // 🔥 Capture after_compaction - context has been compressed
    api.on("after_compaction", (event, eventCtx) => {
        debug(`[langfuse-tracer] [DEBUG] after_compaction: ` +
            `sessionKey=${eventCtx.sessionKey}, success=${event.success}`);
        const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
        const compaction = pendingCompactions.get(key);
        if (!compaction) {
            debug(`[langfuse-tracer] [DEBUG] No pending compaction for ${key}`);
            return;
        }
        // Complete the compaction record
        compaction.endTime = Date.now();
        compaction.messageCountAfter = event.messageCount;
        compaction.systemPromptAfter = event.systemPrompt?.slice(0, dataLimits.systemPrompt);
        compaction.historyAfter = event.messages;
        pendingCompactions.delete(key);
        debug(`[langfuse-tracer] [DEBUG] Completed compaction ${compaction.compactionId}, ` +
            `duration=${compaction.endTime - compaction.startTime}ms, ` +
            `messages: ${compaction.messageCountBefore} → ${compaction.messageCountAfter}`);
    });
    // Finalize and send the trace when agent ends
    api.on("agent_end", async (event, eventCtx) => {
        const { agentId, sessionKey } = eventCtx;
        debug(`[langfuse-tracer] [DEBUG] agent_end: ` +
            `agentId=${agentId}, sessionKey=${sessionKey}, success=${event.success}, messages=${event.messages.length}`);
        // Filter: only track specified agents if trackedAgents is configured
        if (trackedAgents !== null && agentId && !trackedAgents.has(agentId)) {
            debug(`[langfuse-tracer] [DEBUG] Skipping agent ${agentId} (not in trackedAgents)`);
            return;
        }
        const key = sessionKey ?? agentId ?? "default";
        const trace = activeTraces.get(key);
        if (!trace) {
            debug(`[langfuse-tracer] [DEBUG] No active trace for ${key}, skipping agent_end`);
            return;
        }
        const { messages, success, durationMs, error } = event;
        const nowMs = Date.now();
        // Extract final assistant output from messages
        let finalOutput = "";
        let finalAssistantMessage;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.role === "assistant") {
                finalOutput = extractText(msg.content, dataLimits.assistantOutput);
                finalAssistantMessage = msg;
                break;
            }
        }
        // 🔥 Solution A: Complete any pending iteration that didn't fire agent_iteration_end
        // This happens when the final LLM response has no tool calls
        const lastIteration = trace.iterations[trace.iterations.length - 1];
        if (lastIteration && !lastIteration.endTime) {
            debug(`[langfuse-tracer] [DEBUG] Completing final iteration ${lastIteration.iterationId} ` +
                `(#${lastIteration.iterationNumber}) without tool calls (final text response)`);
            lastIteration.endTime = Date.now();
            lastIteration.assistantMessage = finalAssistantMessage;
            lastIteration.toolCalls = []; // No tool calls in final response
            // Extract usage from final assistant message
            if (finalAssistantMessage) {
                const usage = finalAssistantMessage.usage;
                if (usage && typeof usage === "object") {
                    const usageRecord = usage;
                    lastIteration.usage = {
                        input: typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined,
                        output: typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined,
                        cacheRead: typeof usageRecord.cache_read_input_tokens === "number"
                            ? usageRecord.cache_read_input_tokens
                            : undefined,
                        cacheWrite: typeof usageRecord.cache_creation_input_tokens === "number"
                            ? usageRecord.cache_creation_input_tokens
                            : undefined,
                        total: typeof usageRecord.total_tokens === "number" ? usageRecord.total_tokens : undefined,
                    };
                }
            }
            debug(`[langfuse-tracer] [DEBUG] Completed final iteration ${lastIteration.iterationId}, ` +
                `duration=${lastIteration.endTime - lastIteration.startTime}ms, toolCalls=0 (final)`);
        }
        // Build the OTel span tree: one shared traceId, a synthetic root "agent" span
        // (carries trace-level input/output — there's no separate trace-create call under
        // OTLP), with Generations + Iterations + Compactions + tool-call Spans as children.
        let spans = [];
        // Count total spans, generations, iterations, and compactions for summary
        let totalSpans = 0;
        const totalGenerations = trace.generations.length;
        const totalIterations = trace.iterations.length;
        const totalCompactions = trace.compactions.length;
        trace.generations.forEach(gen => { totalSpans += gen.spans.length; });
        trace.iterations.forEach(iter => { totalSpans += iter.spans.length; });
        const traceId = trace.traceId;
        const rootSpanId = newSpanId();
        // Trace-level metadata that needs to be queryable in Langfuse must be copied onto
        // every span (not just set once on a root/trace object) — see AGENTS.md.
        const traceMetadata = {
            success,
            error: error ?? undefined,
            messageCount: messages.length,
            totalGenerations,
            totalIterations,
            totalCompactions,
            totalToolCalls: totalSpans,
            agentDurationMs: durationMs,
        };
        try {
            // Collect all providers and models
            const providers = new Set(trace.generations.map(g => g.provider).filter(Boolean));
            const models = new Set(trace.generations.map(g => g.model).filter(Boolean));
            const tags = [
                "openclaw",
                agentId ?? "unknown",
                ...Array.from(providers),
                ...Array.from(models),
            ];
            const sharedAttrs = buildTraceLevelAttributes({
                agentId,
                sessionKey,
                traceName: "openclaw-agent-run",
                tags,
                metadata: traceMetadata,
            });
            // 1. Root "agent" span — carries the trace-level input/output. Every other span
            // is parented to this one, all sharing `traceId`.
            spans.push({
                traceId,
                spanId: rootSpanId,
                name: "openclaw-agent-run",
                startTimeUnixNano: toUnixNano(trace.startTime),
                endTimeUnixNano: toUnixNano(nowMs),
                attributes: compactAttrs([
                    ...sharedAttrs,
                    attrStr("langfuse.observation.type", "agent"),
                    attrStr("langfuse.observation.input", trace.userInput.slice(0, dataLimits.userInput) || undefined),
                    attrStr("langfuse.observation.output", finalOutput || undefined),
                ]),
            });
            // 2. Create each Generation observation
            trace.generations.forEach((gen) => {
                spans.push({
                    traceId,
                    spanId: gen.generationId,
                    parentSpanId: rootSpanId,
                    name: `llm-call-${gen.model ?? "unknown"}`,
                    startTimeUnixNano: toUnixNano(gen.startTime),
                    endTimeUnixNano: toUnixNano(gen.endTime ?? nowMs),
                    attributes: compactAttrs([
                        ...sharedAttrs,
                        attrStr("langfuse.observation.type", "generation"),
                        attrStr("langfuse.observation.input", gen.input || undefined),
                        attrStr("langfuse.observation.output", gen.output || undefined),
                        attrStr("gen_ai.request.model", gen.model),
                        attrStr("langfuse.observation.model.name", gen.model),
                        attrStr("langfuse.observation.metadata.provider", gen.provider),
                        attrStr("langfuse.observation.metadata.runId", gen.runId),
                        attrInt("langfuse.observation.metadata.toolCallsCount", gen.spans.length),
                        usageDetailsAttribute(gen.usage),
                        ...genAiUsageAttributes(gen.usage),
                    ]),
                });
                // 3. Create each Span (tool call) under this generation
                gen.spans.forEach((span) => {
                    spans.push(buildToolCallSpan(span, gen.generationId, traceId, nowMs, dataLimits, sharedAttrs));
                });
            });
            // 3. Create each Iteration observation (agent_iteration_start → agent_iteration_end)
            trace.iterations.forEach((iter) => {
                // 🏷️ Build structured JSON input for Langfuse parsing
                const inputData = {};
                // TOOL_RESULTS as JSON key
                if (iter.toolResults && iter.toolResults.length > 0) {
                    inputData.TOOL_RESULTS = {
                        count: iter.toolResults.length,
                        results: iter.toolResults,
                    };
                }
                // RECENT_HISTORY as JSON key
                if (iter.recentMessages && iter.recentMessages.length > 0) {
                    inputData.RECENT_HISTORY = {
                        count: iter.recentMessages.length,
                        messages: iter.recentMessages,
                    };
                }
                // Convert input to JSON string
                let inputStr;
                try {
                    inputStr = Object.keys(inputData).length > 0
                        ? JSON.stringify(inputData, null, 2)
                        : undefined;
                }
                catch (err) {
                    inputStr = JSON.stringify({ error: "Failed to serialize input" });
                }
                // 🏷️ Build structured JSON output for Langfuse parsing
                const outputData = {};
                // ASSISTANT_OUTPUT as JSON key
                if (iter.assistantMessage) {
                    outputData.ASSISTANT_OUTPUT = iter.assistantMessage;
                }
                // TOOL_CALLS_PLANNED as JSON key
                if (iter.toolCalls && iter.toolCalls.length > 0) {
                    outputData.TOOL_CALLS_PLANNED = iter.toolCalls;
                }
                // Convert output to JSON string
                let outputStr;
                try {
                    outputStr = Object.keys(outputData).length > 0
                        ? JSON.stringify(outputData, null, 2)
                        : undefined;
                }
                catch (err) {
                    outputStr = JSON.stringify({ error: "Failed to serialize output" });
                }
                spans.push({
                    traceId,
                    spanId: iter.iterationId,
                    parentSpanId: rootSpanId,
                    name: `iteration-${iter.iterationNumber}`,
                    startTimeUnixNano: toUnixNano(iter.startTime),
                    endTimeUnixNano: toUnixNano(iter.endTime ?? nowMs),
                    attributes: compactAttrs([
                        ...sharedAttrs,
                        attrStr("langfuse.observation.type", "generation"),
                        attrStr("langfuse.observation.input", inputStr),
                        attrStr("langfuse.observation.output", outputStr),
                        attrStr("langfuse.observation.metadata.iterationType", "llm-iteration"),
                        attrInt("langfuse.observation.metadata.iterationNumber", iter.iterationNumber),
                        attrStr("langfuse.observation.metadata.runId", iter.runId),
                        attrInt("langfuse.observation.metadata.toolCallsPlanned", iter.toolCalls?.length ?? 0),
                        usageDetailsAttribute(iter.usage),
                        ...genAiUsageAttributes(iter.usage),
                    ]),
                });
                // Attach tool execution spans under this iteration
                iter.spans.forEach((span) => {
                    spans.push(buildToolCallSpan(span, iter.iterationId, traceId, nowMs, dataLimits, sharedAttrs));
                });
            });
            // 4. Create each Compaction observation
            trace.compactions.forEach((comp) => {
                // 🏷️ Build structured JSON for compaction changes
                const inputData = {};
                // BEFORE_COMPACTION as JSON key
                if (comp.messageCountBefore || comp.systemPromptBefore || comp.historyBefore) {
                    inputData.BEFORE_COMPACTION = {
                        messageCount: comp.messageCountBefore,
                        systemPrompt: comp.systemPromptBefore?.slice(0, 1000),
                        historyMessageCount: comp.historyBefore?.length,
                    };
                }
                // AFTER_COMPACTION as JSON key
                if (comp.messageCountAfter || comp.systemPromptAfter || comp.historyAfter) {
                    inputData.AFTER_COMPACTION = {
                        messageCount: comp.messageCountAfter,
                        systemPrompt: comp.systemPromptAfter?.slice(0, 1000),
                        historyMessageCount: comp.historyAfter?.length,
                        note: "AGENTS.md sections re-injected",
                    };
                }
                // Convert to JSON string
                let inputStr;
                try {
                    inputStr = JSON.stringify(inputData, null, 2);
                }
                catch (err) {
                    inputStr = JSON.stringify({ error: "Failed to serialize compaction data" });
                }
                // Build output summary
                const outputData = {
                    messageReduction: {
                        before: comp.messageCountBefore ?? 0,
                        after: comp.messageCountAfter ?? 0,
                        reduced: (comp.messageCountBefore ?? 0) - (comp.messageCountAfter ?? 0),
                    },
                };
                spans.push({
                    traceId,
                    spanId: comp.compactionId,
                    parentSpanId: rootSpanId,
                    name: "compaction",
                    startTimeUnixNano: toUnixNano(comp.startTime),
                    endTimeUnixNano: toUnixNano(comp.endTime ?? nowMs),
                    attributes: compactAttrs([
                        ...sharedAttrs,
                        attrStr("langfuse.observation.type", "span"),
                        attrStr("langfuse.observation.input", inputStr),
                        attrStr("langfuse.observation.output", JSON.stringify(outputData, null, 2)),
                        attrStr("langfuse.observation.metadata.type", "context-compaction"),
                        attrInt("langfuse.observation.metadata.messageCountBefore", comp.messageCountBefore),
                        attrInt("langfuse.observation.metadata.messageCountAfter", comp.messageCountAfter),
                        attrInt("langfuse.observation.metadata.reduction", comp.messageCountBefore && comp.messageCountAfter
                            ? comp.messageCountBefore - comp.messageCountAfter
                            : undefined),
                    ]),
                });
            });
        }
        catch (err) {
            // Even a malformed/killed trace is worth debugging in Langfuse — never drop it
            // silently just because one generation/iteration/span failed to serialize.
            api.logger.warn(`[langfuse-tracer] Failed to build full span tree for trace ${traceId}, ` +
                `sending minimal root span instead: ${String(err)}`);
            const fallbackAttrs = buildTraceLevelAttributes({
                agentId,
                sessionKey,
                traceName: "openclaw-agent-run",
                tags: ["openclaw", agentId ?? "unknown", "batch-build-error"],
                metadata: { ...traceMetadata, batchBuildError: String(err) },
            });
            spans = [{
                    traceId,
                    spanId: rootSpanId,
                    name: "openclaw-agent-run",
                    startTimeUnixNano: toUnixNano(trace.startTime),
                    endTimeUnixNano: toUnixNano(nowMs),
                    attributes: compactAttrs([
                        ...fallbackAttrs,
                        attrStr("langfuse.observation.type", "agent"),
                        attrStr("langfuse.observation.input", (trace.userInput || "").slice(0, dataLimits.userInput) || undefined),
                        attrStr("langfuse.observation.output", finalOutput || undefined),
                    ]),
                }];
        }
        // Cleanup
        activeTraces.delete(key);
        trace.generations.forEach(gen => activeGenerations.delete(gen.runId));
        trace.iterations.forEach(iter => activeIterations.delete(iter.runId));
        debug(`[langfuse-tracer] [DEBUG] Sending OTLP export: ` +
            `${totalGenerations} generations, ${totalIterations} iterations, ` +
            `${totalCompactions} compactions, ${totalSpans} spans, ` +
            `${spans.length} total OTel spans`);
        const exportRequest = {
            resourceSpans: [
                {
                    resource: { attributes: [] },
                    scopeSpans: [
                        {
                            scope: { name: "openclaw-langfuse-tracer" },
                            spans,
                        },
                    ],
                },
            ],
        };
        try {
            const res = await fetch(`${trace.credentials.baseUrl}/api/public/otel/v1/traces`, {
                method: "POST",
                headers: {
                    Authorization: trace.credentials.authHeader,
                    "Content-Type": "application/json",
                    "x-langfuse-ingestion-version": "4",
                },
                body: JSON.stringify(exportRequest),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                api.logger.warn(`[langfuse-tracer] OTLP export failed ${res.status}: ${text.slice(0, 200)}`);
            }
            else {
                api.logger.info(`[langfuse-tracer] ✓ Sent trace ${traceId} for agent "${agentId}": ` +
                    `${totalGenerations} generations, ${totalIterations} iterations, ` +
                    `${totalCompactions} compactions, ${totalSpans} tool calls`);
            }
        }
        catch (err) {
            api.logger.warn(`[langfuse-tracer] Fetch error: ${String(err)}`);
        }
    });
}
//# sourceMappingURL=tracer.js.map