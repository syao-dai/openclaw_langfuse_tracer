import type { OpenClawPluginApi } from "../api.js";

/**
 * langfuse-tracer — OpenClaw plugin
 *
 * Sends an agent trace + LLM generation to Langfuse after every agent turn.
 * Uses the Langfuse REST API directly (no npm packages required).
 *
 * Required env vars:
 *   LANGFUSE_PUBLIC_KEY   — project public key
 *   LANGFUSE_SECRET_KEY   — project secret key
 *   LANGFUSE_BASE_URL     — e.g. http://172.21.0.1:3050
 */

interface PluginConfig {
  trackedAgents?: string[];
}

interface PendingPrompt {
  prompt: string;
  startedAt: number;
}

interface RunContext {
  runId: string;
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  historyMessages?: unknown[];
  toolCalls: ToolCallRecord[];
  llmInput?: {
    timestamp: number;
    imagesCount: number;
  };
  llmOutput?: {
    timestamp: number;
    assistantTexts: string[];
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
}

interface ToolCallRecord {
  toolName: string;
  toolCallId?: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  timestamp: number;
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

interface LangfuseUsage {
  input?: number;
  output?: number;
  unit: "TOKENS";
}

interface LangfuseBatchItem {
  id: string;
  type: "trace-create" | "generation-create";
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
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = (process.env.LANGFUSE_BASE_URL?.trim() ?? "http://172.21.0.1:3050").replace(
    /\/$/,
    "",
  );

  if (!publicKey || !secretKey) {
    api.logger.info(
      "[langfuse-tracer] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled",
    );
    return;
  }

  const authHeader = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

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

  // Store run contexts keyed by runId
  const runContexts = new Map<string, RunContext>();
  const pendingPrompts = new Map<string, PendingPrompt>();

  api.on("before_agent_start", (event, eventCtx) => {
    const key = eventCtx.sessionKey ?? eventCtx.agentId ?? "default";
    pendingPrompts.set(key, {
      prompt: event.prompt ?? "",
      startedAt: Date.now(),
    });
  });

  // Capture LLM input (system prompt, history)
  api.on("llm_input", (event, eventCtx) => {
    const ctx: RunContext = {
      runId: event.runId,
      sessionId: event.sessionId,
      agentId: eventCtx.agentId,
      sessionKey: eventCtx.sessionKey,
      provider: event.provider,
      model: event.model,
      systemPrompt: event.systemPrompt,
      historyMessages: event.historyMessages,
      toolCalls: [],
      llmInput: {
        timestamp: Date.now(),
        imagesCount: event.imagesCount,
      },
    };
    runContexts.set(event.runId, ctx);
  });

  // Capture LLM output (usage stats)
  api.on("llm_output", (event, eventCtx) => {
    const ctx = runContexts.get(event.runId);
    if (ctx) {
      ctx.llmOutput = {
        timestamp: Date.now(),
        assistantTexts: event.assistantTexts,
        usage: event.usage,
      };
    }
  });

  // Capture tool calls
  api.on("before_tool_call", (event, toolCtx) => {
    const ctx = event.runId ? runContexts.get(event.runId) : null;
    if (ctx) {
      ctx.toolCalls.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        params: event.params,
        timestamp: Date.now(),
      });
    }
  });

  api.on("after_tool_call", (event, toolCtx) => {
    const ctx = event.runId ? runContexts.get(event.runId) : null;
    if (ctx) {
      const toolCall = ctx.toolCalls.find(
        (t) => t.toolName === event.toolName && t.toolCallId === event.toolCallId,
      );
      if (toolCall) {
        toolCall.result = event.result;
        toolCall.error = event.error;
        toolCall.durationMs = event.durationMs;
      }
    }
  });

  api.on("agent_end", async (event, eventCtx) => {
    const { agentId, sessionKey } = eventCtx;

    // Filter: only track specified agents if trackedAgents is configured
    if (trackedAgents !== null && agentId && !trackedAgents.has(agentId)) {
      return; // Skip this agent
    }

    const { messages, success, durationMs, error } = event;

    const key = sessionKey ?? agentId ?? "default";
    const pending = pendingPrompts.get(key);
    pendingPrompts.delete(key);

    // Find the run context for this agent turn (most recent one for this session)
    let runCtx: RunContext | undefined;
    for (const ctx of runContexts.values()) {
      if (
        ctx.agentId === agentId &&
        ctx.sessionKey === sessionKey &&
        (!runCtx || ctx.llmInput && ctx.llmInput.timestamp > (runCtx.llmInput?.timestamp ?? 0))
      ) {
        runCtx = ctx;
      }
    }

    const now = new Date().toISOString();
    const startedAt = pending?.startedAt ?? (durationMs ? Date.now() - durationMs : Date.now());
    const startTime = new Date(startedAt).toISOString();

    // --- Extract user input ---
    let userInput = pending?.prompt ?? "";
    if (!userInput) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as MessageContent | undefined;
        if (msg?.role === "user") {
          userInput = extractText(msg.content, 2000);
          break;
        }
      }
    }

    // --- Extract assistant output ---
    let assistantOutput = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as MessageContent | undefined;
      if (msg?.role === "assistant") {
        assistantOutput = extractText(msg.content, 10000); // Increase limit
        break;
      }
    }

    // --- Build comprehensive input (user prompt + system prompt + history summary) ---
    const inputParts: string[] = [];
    
    // User prompt
    if (userInput) {
      inputParts.push(`### User Input\n${userInput}`);
    }

    // System prompt from llm_input
    if (runCtx?.systemPrompt) {
      inputParts.push(`\n### System Prompt\n${runCtx.systemPrompt.slice(0, 20000)}`);
    }

    // History messages summary
    if (runCtx?.historyMessages && runCtx.historyMessages.length > 0) {
      inputParts.push(
        `\n### Conversation History (${runCtx.historyMessages.length} messages)\n` +
          JSON.stringify(runCtx.historyMessages, null, 2).slice(0, 5000),
      );
    }

    const fullInput = inputParts.join("\n");

    // --- Build comprehensive output (assistant reply + tool calls) ---
    const outputParts: string[] = [];

    // Assistant text
    if (assistantOutput) {
      outputParts.push(`### Assistant Response\n${assistantOutput}`);
    }

    // Tool calls
    if (runCtx?.toolCalls && runCtx.toolCalls.length > 0) {
      outputParts.push(`\n### Tool Calls (${runCtx.toolCalls.length})`);
      runCtx.toolCalls.forEach((tool, idx) => {
        outputParts.push(
          `\n#### ${idx + 1}. ${tool.toolName}` +
            `\n- Duration: ${tool.durationMs ?? "?"}ms` +
            `\n- Params: ${JSON.stringify(tool.params).slice(0, 500)}` +
            (tool.error
              ? `\n- Error: ${tool.error}`
              : `\n- Result: ${JSON.stringify(tool.result).slice(0, 1000)}`),
        );
      });
    }

    const fullOutput = outputParts.join("\n");

    // --- Extract token usage (prefer from llm_output, fallback to message usage) ---
    let usage: LangfuseUsage | undefined;
    if (runCtx?.llmOutput?.usage) {
      const u = runCtx.llmOutput.usage;
      usage = {
        input: u.input,
        output: u.output,
        unit: "TOKENS",
      };
    } else {
      // Fallback to message usage
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as MessageContent | undefined;
        if (msg?.role === "assistant" && msg.usage) {
          const u = msg.usage;
          usage = {
            input: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
            output: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
            unit: "TOKENS",
          };
          break;
        }
      }
    }

    const traceId = randomId();
    const generationId = randomId();
    const batchItemId1 = randomId();
    const batchItemId2 = randomId();

    const batch: LangfuseBatchItem[] = [
      {
        id: batchItemId1,
        type: "trace-create",
        timestamp: now,
        body: {
          id: traceId,
          name: "openclaw-agent-turn",
          sessionId: sessionKey ?? undefined,
          userId: agentId ?? "unknown",
          tags: [
            "openclaw",
            agentId ?? "unknown",
            runCtx?.provider || "unknown-provider",
            runCtx?.model || "unknown-model",
          ],
          input: fullInput || undefined,
          output: fullOutput || undefined,
          metadata: {
            success,
            error: error ?? undefined,
            messageCount: messages.length,
            provider: runCtx?.provider,
            model: runCtx?.model,
            toolCallsCount: runCtx?.toolCalls.length ?? 0,
            imagesCount: runCtx?.llmInput?.imagesCount ?? 0,
            historyMessagesCount: runCtx?.historyMessages?.length ?? 0,
          },
          timestamp: startTime,
        },
      },
      {
        id: batchItemId2,
        type: "generation-create",
        timestamp: now,
        body: {
          id: generationId,
          traceId,
          name: "llm-generation",
          model: runCtx?.model,
          startTime,
          endTime: now,
          input: fullInput || undefined,
          output: fullOutput || undefined,
          level: success ? "DEFAULT" : "ERROR",
          statusMessage: error ?? undefined,
          usage,
          metadata: {
            durationMs,
            messageCount: messages.length,
            provider: runCtx?.provider,
            runId: runCtx?.runId,
            sessionId: runCtx?.sessionId,
            toolCalls: runCtx?.toolCalls.map((t) => ({
              name: t.toolName,
              durationMs: t.durationMs,
              error: t.error,
            })),
          },
        },
      },
    ];

    // Clean up old run contexts (keep last 100)
    if (runContexts.size > 100) {
      const oldestKeys = Array.from(runContexts.keys()).slice(0, runContexts.size - 100);
      oldestKeys.forEach((k) => runContexts.delete(k));
    }

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
          `[langfuse-tracer] Successfully sent trace for agent "${agentId}" (${messages.length} msgs, ${runCtx?.toolCalls.length ?? 0} tools)`,
        );
      }
    } catch (err) {
      api.logger.warn(`[langfuse-tracer] Fetch error: ${String(err)}`);
    }
  });
}
