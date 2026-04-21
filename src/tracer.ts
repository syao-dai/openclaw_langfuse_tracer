import type { OpenClawPluginApi } from "../api.js";

/**
 * langfuse-tracer — OpenClaw plugin
 *
 * Traces OpenClaw agent executions to Langfuse following the proper observability data model:
 * - Each agent run (before_agent_start → agent_end) = ONE Trace
 * - Each llm_input/llm_output pair = ONE Generation observation
 * - Each tool call = ONE Span observation (nested under its Generation)
 *
 * Uses the Langfuse REST API directly (no npm packages required).
 *
 * Configuration via openclaw.json:
 *   langfuse.publicKey      — Langfuse project public key (required)
 *   langfuse.secretKey      — Langfuse project secret key (required)
 *   langfuse.baseUrl        — Langfuse server URL (default: http://172.21.0.1:3050)
 *   
 *   limits.userInput        — Max chars for user input (default: 2000)
 *   limits.assistantOutput  — Max chars for assistant output (default: 10000)
 *   limits.systemPrompt     — Max chars for system prompt (default: 20000)
 *   limits.history          — Max chars for conversation history JSON (default: 5000)
 *   limits.toolParams       — Max chars for tool parameters (default: 500)
 *   limits.toolResult       — Max chars for tool result (default: 1000)
 *   
 *   trackedAgents           — Array of agent IDs to trace (default: [] = all agents)
 *
 * Example configuration:
 *   openclaw config set plugins.entries.langfuse-tracer.config.langfuse.publicKey "pk-lf-xxx"
 *   openclaw config set plugins.entries.langfuse-tracer.config.langfuse.secretKey "sk-lf-xxx"
 *   openclaw config set plugins.entries.langfuse-tracer.config.langfuse.baseUrl "http://langfuse:3000"
 */

interface PluginConfig {
  trackedAgents?: string[];
  logLevel?: "info" | "debug";
  langfuse?: {
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
  };
  limits?: {
    userInput?: number;
    assistantOutput?: number;
    systemPrompt?: number;
    history?: number;
    toolParams?: number;
    toolResult?: number;
  };
}

// Represents an active agent trace (one agent run from start to end)
interface AgentTrace {
  traceId: string;
  agentId?: string;
  sessionKey?: string;
  userInput: string;  // Original user prompt from before_agent_start
  startTime: number;
  generations: GenerationRecord[];  // All LLM calls during this agent run
}

// Represents one LLM generation (llm_input + llm_output pair)
interface GenerationRecord {
  generationId: string;
  runId: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  historyMessages?: unknown[];
  startTime: number;
  endTime?: number;
  input: string;  // The prompt sent to LLM
  output?: string;  // The LLM response
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  spans: SpanRecord[];  // Tool calls that happened during this generation
}

// Represents one tool call (span observation)
interface SpanRecord {
  spanId: string;
  toolName: string;
  toolCallId?: string;
  startTime: number;
  endTime?: number;
  input: Record<string, unknown>;  // Tool parameters
  output?: unknown;  // Tool result
  error?: string;
  metadata?: Record<string, unknown>;
}

interface MessageContent {
  role?: string;
  content?: string | ContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface LangfuseBatchItem {
  id: string;
  type: "trace-create" | "generation-create" | "span-create";
  timestamp: string;
  body: Record<string, unknown>;
}

function extractText(content: string | ContentBlock[] | undefined, maxLen: number): string {
  if (typeof content === "string") {
    return content.slice(0, maxLen);
  }
  if (Array.isArray(content)) {
    return content
      .filter((c): c is ContentBlock => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .slice(0, maxLen);
  }
  return "";
}

function randomId(): string {
  return crypto.randomUUID();
}

export function setupLangfuseTracer(api: OpenClawPluginApi): void {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  
  // Setup logging
  const logLevel = pluginConfig.logLevel ?? "info";
  const isDebug = logLevel === "debug";
  const debug = (message: string) => {
    if (isDebug) api.logger.info(message);
  };
  
  // Read credentials from plugin config only
  const publicKey = pluginConfig.langfuse?.publicKey?.trim();
  const secretKey = pluginConfig.langfuse?.secretKey?.trim();
  const baseUrl = (
    pluginConfig.langfuse?.baseUrl?.trim() 
    ?? "http://172.21.0.1:3050"
  ).replace(/\/$/, "");

  if (!publicKey || !secretKey) {
    api.logger.info(
      "[langfuse-tracer] Langfuse credentials not configured. " +
      "Configure via openclaw.json:\n" +
      "  openclaw config set plugins.entries.langfuse-tracer.config.langfuse.publicKey 'pk-lf-xxx'\n" +
      "  openclaw config set plugins.entries.langfuse-tracer.config.langfuse.secretKey 'sk-lf-xxx'\n" +
      "  openclaw config set plugins.entries.langfuse-tracer.config.langfuse.baseUrl 'http://langfuse:3000'\n" +
      "— tracing disabled",
    );
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  // Parse data limits from plugin config with defaults
  const dataLimits = {
    userInput: pluginConfig.limits?.userInput ?? 2000,
    assistantOutput: pluginConfig.limits?.assistantOutput ?? 10000,
    systemPrompt: pluginConfig.limits?.systemPrompt ?? 20000,
    history: pluginConfig.limits?.history ?? 5000,
    toolParams: pluginConfig.limits?.toolParams ?? 500,
    toolResult: pluginConfig.limits?.toolResult ?? 1000,
  };

  api.logger.info(
    `[langfuse-tracer] Data limits: ` +
    `user=${dataLimits.userInput}, ` +
    `assistant=${dataLimits.assistantOutput}, ` +
    `system=${dataLimits.systemPrompt}, ` +
    `history=${dataLimits.history}, ` +
    `toolParams=${dataLimits.toolParams}, ` +
    `toolResult=${dataLimits.toolResult}`,
  );

  // Parse tracked agents configuration
  let trackedAgents: Set<string> | null = null; // null = track all agents
  if (Array.isArray(pluginConfig.trackedAgents) && pluginConfig.trackedAgents.length > 0) {
    trackedAgents = new Set(pluginConfig.trackedAgents);
    api.logger.info(
      `[langfuse-tracer] Tracking specific agents: ${Array.from(trackedAgents).join(", ")}`,
    );
  } else {
    api.logger.info("[langfuse-tracer] Tracking all agents");
  }

  api.logger.info(`[langfuse-tracer] Langfuse tracing enabled → ${baseUrl}`);
  if (isDebug) {
    api.logger.info(`[langfuse-tracer] Debug mode enabled`);
  }

  // Store active agent traces keyed by session key
  const activeTraces = new Map<string, AgentTrace>();
  // Store current generation for each runId
  const activeGenerations = new Map<string, GenerationRecord>();
  // Store pending tool calls keyed by runId+toolCallId
  const pendingToolCalls = new Map<string, SpanRecord>();

  api.on("before_agent_start", (event, eventCtx) => {
    debug(
      `[langfuse-tracer] [DEBUG] before_agent_start: ` +
      `agentId=${eventCtx.agentId}, sessionKey=${eventCtx.sessionKey}, ` +
      `prompt=${event.prompt?.slice(0, 100)}...`,
    );
    
    // Filter: only track specified agents if trackedAgents is configured
    if (trackedAgents !== null && eventCtx.agentId && !trackedAgents.has(eventCtx.agentId)) {
      debug(`[langfuse-tracer] [DEBUG] Skipping agent ${eventCtx.agentId} (not in trackedAgents)`);
      return;
    }
    
    const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
    const traceId = randomId();
    
    // Create a new trace for this agent run
    const trace: AgentTrace = {
      traceId,
      agentId: eventCtx.agentId,
      sessionKey: eventCtx.sessionKey,
      userInput: event.prompt ?? "",
      startTime: Date.now(),
      generations: [],
    };
    
    activeTraces.set(key, trace);
    debug(`[langfuse-tracer] [DEBUG] Created trace ${traceId} for ${key}`);
  });

  // Capture LLM input - start a new Generation observation
  api.on("llm_input", (event, eventCtx) => {
    debug(
      `[langfuse-tracer] [DEBUG] llm_input: ` +
      `runId=${event.runId}, model=${event.model}, provider=${event.provider}`,
    );
    
    const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
    const trace = activeTraces.get(key);
    if (!trace) {
      debug(`[langfuse-tracer] [DEBUG] No active trace for ${key}, skipping generation`);
      return;
    }
    
    const generationId = randomId();
    
    // Build input for this generation (system prompt + history)
    const inputParts: string[] = [];
    if (event.systemPrompt) {
      inputParts.push(event.systemPrompt.slice(0, dataLimits.systemPrompt));
    }
    if (event.historyMessages && event.historyMessages.length > 0) {
      inputParts.push(
        `\n### Conversation History (${event.historyMessages.length} messages)\n` +
        JSON.stringify(event.historyMessages, null, 2).slice(0, dataLimits.history)
      );
    }
    
    const generation: GenerationRecord = {
      generationId,
      runId: event.runId,
      model: event.model,
      provider: event.provider,
      systemPrompt: event.systemPrompt,
      historyMessages: event.historyMessages,
      startTime: Date.now(),
      input: inputParts.join("\n"),
      spans: [],
    };
    
    activeGenerations.set(event.runId, generation);
    trace.generations.push(generation);
    
    debug(
      `[langfuse-tracer] [DEBUG] Created generation ${generationId} for trace ${trace.traceId}`,
    );
  });

  // Capture LLM output - complete the Generation observation
  api.on("llm_output", (event, eventCtx) => {
    debug(
      `[langfuse-tracer] [DEBUG] llm_output: ` +
      `runId=${event.runId}, usage=${JSON.stringify(event.usage)}`,
    );
    
    const generation = activeGenerations.get(event.runId);
    if (!generation) {
      debug(`[langfuse-tracer] [DEBUG] No active generation for runId ${event.runId}`);
      return;
    }
    
    // Complete the generation with output and usage
    generation.endTime = Date.now();
    generation.output = event.assistantTexts.join("\n").slice(0, dataLimits.assistantOutput);
    generation.usage = event.usage;
    
    debug(
      `[langfuse-tracer] [DEBUG] Completed generation ${generation.generationId}, ` +
      `duration=${generation.endTime - generation.startTime}ms, ` +
      `spans=${generation.spans.length}`,
    );
  });

  // Capture tool calls - create Span observations nested under the current Generation
  api.on("before_tool_call", (event, toolCtx) => {
    debug(
      `[langfuse-tracer] [DEBUG] before_tool_call: ` +
      `runId=${event.runId}, tool=${event.toolName}`,
    );
    
    const generation = event.runId ? activeGenerations.get(event.runId) : null;
    if (!generation) {
      debug(`[langfuse-tracer] [DEBUG] No active generation for tool call ${event.toolName}`);
      return;
    }
    
    const spanId = randomId();
    const spanKey = `${event.runId}:${event.toolCallId ?? spanId}`;
    
    const span: SpanRecord = {
      spanId,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      startTime: Date.now(),
      input: event.params,
    };
    
    pendingToolCalls.set(spanKey, span);
    generation.spans.push(span);
    
    debug(
      `[langfuse-tracer] [DEBUG] Created span ${spanId} (${event.toolName}) ` +
      `under generation ${generation.generationId}`,
    );
  });

  api.on("after_tool_call", (event, toolCtx) => {
    debug(
      `[langfuse-tracer] [DEBUG] after_tool_call: ` +
      `runId=${event.runId}, tool=${event.toolName}, durationMs=${event.durationMs}`,
    );
    
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
    
    debug(
      `[langfuse-tracer] [DEBUG] Completed span ${span.spanId} (${event.toolName}), ` +
      `duration=${event.durationMs}ms`,
    );
  });

  // Finalize and send the trace when agent ends
  api.on("agent_end", async (event, eventCtx) => {
    const { agentId, sessionKey } = eventCtx;
    
    debug(
      `[langfuse-tracer] [DEBUG] agent_end: ` +
      `agentId=${agentId}, sessionKey=${sessionKey}, success=${event.success}, messages=${event.messages.length}`,
    );

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
    const now = new Date().toISOString();
    const startTime = new Date(trace.startTime).toISOString();

    // Extract final assistant output from messages
    let finalOutput = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as MessageContent | undefined;
      if (msg?.role === "assistant") {
        finalOutput = extractText(msg.content, dataLimits.assistantOutput);
        break;
      }
    }

    // Build the batch: Trace + Generations + Spans (nested structure)
    const batch: LangfuseBatchItem[] = [];
    
    // Count total spans and generations for summary
    let totalSpans = 0;
    let totalGenerations = trace.generations.length;
    trace.generations.forEach(gen => { totalSpans += gen.spans.length; });
    
    // Collect all providers and models
    const providers = new Set(trace.generations.map(g => g.provider).filter(Boolean));
    const models = new Set(trace.generations.map(g => g.model).filter(Boolean));
    
    // 1. Create the Trace
    batch.push({
      id: randomId(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: trace.traceId,
        name: "openclaw-agent-run",
        sessionId: sessionKey ?? undefined,
        userId: agentId ?? "unknown",
        tags: [
          "openclaw",
          agentId ?? "unknown",
          ...Array.from(providers),
          ...Array.from(models),
        ],
        input: trace.userInput.slice(0, dataLimits.userInput) || undefined,
        output: finalOutput || undefined,
        metadata: {
          success,
          error: error ?? undefined,
          messageCount: messages.length,
          totalGenerations,
          totalToolCalls: totalSpans,
          agentDurationMs: durationMs,
        },
        timestamp: startTime,
      },
    });
    
    // 2. Create each Generation observation
    trace.generations.forEach((gen) => {
      const genStartTime = new Date(gen.startTime).toISOString();
      const genEndTime = gen.endTime ? new Date(gen.endTime).toISOString() : now;
      
      batch.push({
        id: randomId(),
        type: "generation-create",
        timestamp: now,
        body: {
          id: gen.generationId,
          traceId: trace.traceId,
          name: `llm-call-${gen.model ?? "unknown"}`,
          model: gen.model,
          startTime: genStartTime,
          endTime: genEndTime,
          input: gen.input || undefined,
          output: gen.output || undefined,
          usage: gen.usage ? {
            input: gen.usage.input,
            output: gen.usage.output,
            unit: "TOKENS" as const,
          } : undefined,
          metadata: {
            provider: gen.provider,
            runId: gen.runId,
            toolCallsCount: gen.spans.length,
            cacheRead: gen.usage?.cacheRead,
            cacheWrite: gen.usage?.cacheWrite,
          },
        },
      });
      
      // 3. Create each Span (tool call) under this generation
      gen.spans.forEach((span) => {
        const spanStartTime = new Date(span.startTime).toISOString();
        const spanEndTime = span.endTime ? new Date(span.endTime).toISOString() : now;
        
        batch.push({
          id: randomId(),
          type: "span-create",
          timestamp: now,
          body: {
            id: span.spanId,
            traceId: trace.traceId,
            parentObservationId: gen.generationId,  // Nest under generation
            name: span.toolName,
            startTime: spanStartTime,
            endTime: spanEndTime,
            input: JSON.stringify(span.input).slice(0, dataLimits.toolParams),
            output: span.error 
              ? `ERROR: ${span.error}` 
              : JSON.stringify(span.output).slice(0, dataLimits.toolResult),
            level: span.error ? "ERROR" : "DEFAULT",
            statusMessage: span.error ?? undefined,
            metadata: span.metadata,
          },
        });
      });
    });
    
    // Cleanup
    activeTraces.delete(key);
    trace.generations.forEach(gen => activeGenerations.delete(gen.runId));
    
    debug(
      `[langfuse-tracer] [DEBUG] Sending batch: ` +
      `${totalGenerations} generations, ${totalSpans} spans, ` +
      `${batch.length} total items`,
    );

    try {
      const res = await fetch(`${baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        api.logger.warn(
          `[langfuse-tracer] Ingestion failed ${res.status}: ${text.slice(0, 200)}`,
        );
      } else {
        api.logger.info(
          `[langfuse-tracer] ✓ Sent trace ${trace.traceId} for agent "${agentId}": ` +
          `${totalGenerations} generations, ${totalSpans} tool calls`,
        );
      }
    } catch (err) {
      api.logger.warn(`[langfuse-tracer] Fetch error: ${String(err)}`);
    }
  });
}
