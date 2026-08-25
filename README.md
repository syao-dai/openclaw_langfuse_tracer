# Langfuse Tracer for OpenClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.3.26-blue)](https://github.com/yourusername/openclaw)

A comprehensive tracing plugin for [OpenClaw](https://github.com/OpenClaw/openclaw) that sends detailed agent execution traces to your self-hosted [Langfuse](https://langfuse.com/) instance for observability and analysis.

## 🌟 Features

### Complete Observability

- 📝 **Full System Prompts** - Captures complete system prompts including truncated AGENTS.md content (up to 20,000 chars)
- 💬 **Conversation History** - Records conversation context with JSON formatting (up to 5,000 chars)
- 🔧 **Tool Call Tracking** - Monitors all tool invocations with parameters, results, and execution time
- 📊 **Token Usage** - Precise tracking of input/output tokens and cache hits/writes
- ⏱️ **Performance Metrics** - Detailed timing data for agent runs and tool executions
- 🔥 **Per-Iteration Tracking** - NEW! Monitor each LLM decision cycle separately with `agent_iteration_start`/`agent_iteration_end` hooks
- 🔄 **Compaction Visibility** - NEW! Track context compression events with `before_compaction`/`after_compaction` hooks
- 🏷️ **Tagged Inputs** - NEW! Clear section markers for system prompts, history, tool results, and outputs
- 🔑 **Multi-Project Credentials** - NEW! Route different agents (or agent groups) to different Langfuse projects via `credentials[].agentIds`, instead of one shared project for the whole plugin

### Production Ready

- 🏠 **Self-Hosted** - All data stays in your infrastructure
- 🚀 **Zero Dependencies** - Uses native `fetch` API, no npm packages required
- ⚡ **Non-Blocking** - Asynchronous sending with error handling
- 🎯 **Selective Tracing** - Configure which agents to track
- 🔒 **Secure** - Basic Auth with environment variable credentials

## 📸 Screenshots

### Langfuse Trace View (Updated Structure)

Your OpenClaw agent interactions now appear in Langfuse with granular iteration tracking:

```
Trace: openclaw-agent-run
├─ Generation: llm-call-initial
│  ├─ Input:
│  │  ├─ [INITIAL_SYSTEM_PROMPT] "You are a personal assistant..."
│  │  ├─ [INITIAL_HISTORY] (5 messages)
│  │  └─ [USER_PROMPT] "Analyze Q1 sales data"
│  └─ Output: Cumulative response
│
├─ Generation: iteration-1
│  ├─ Input:
│  │  ├─ [TOOL_RESULTS] (empty, first iteration)
│  │  └─ [RECENT_HISTORY] (last 2 messages)
│  ├─ Output: [ASSISTANT_OUTPUT] (decided: read IDENTITY.md, read USER.md)
│  └─ Spans:
│     ├─ read (333ms) - Read IDENTITY.md
│     └─ read (349ms) - Read USER.md
│
├─ Generation: iteration-2
│  ├─ Input:
│  │  ├─ [TOOL_RESULTS] (2 results from iteration-1)
│  │  └─ [RECENT_HISTORY] (last 2 messages)
│  ├─ Output: [ASSISTANT_OUTPUT] (decided: exec SQL query)
│  └─ Spans:
│     └─ exec (379ms) - Run SQL query
│
├─ Span: compaction (if triggered)
│  ├─ Input:
│  │  ├─ [BEFORE_COMPACTION] (50 messages, full system prompt)
│  │  └─ [AFTER_COMPACTION] (15 messages, re-injected AGENTS.md sections)
│  └─ Output: "Messages: 50 → 15 (reduced 35)"
│
└─ Generation: iteration-3
   ├─ Input:
   │  ├─ [TOOL_RESULTS] (1 result from iteration-2)
   │  └─ [RECENT_HISTORY] (last 2 messages)
   ├─ Output: [ASSISTANT_OUTPUT] (final answer, no more tools)
   └─ Metadata:
      ├─ Provider: amazon-bedrock
      ├─ Model: claude-sonnet-4
      ├─ Per-iteration tokens: 2,345 input, 234 output
      └─ Cache: 890 read, 0 write
```

## 🚀 Quick Start

### Prerequisites

- OpenClaw 2026.3.26 or later
- Self-hosted Langfuse instance
- Langfuse project credentials (public key & secret key)

### Installation

1. **Clone or download this plugin**

```bash
cd ~/.openclaw/workspace-<your-workspace>/.openclaw/extensions
git clone https://github.com/syao-dai/openclaw_langfuse_tracer.git langfuse-tracer
```

2. **Install the plugin**

```bash
openclaw plugins install /path/to/langfuse-tracer -l
openclaw gateway restart
```

3. **⚠️ Enable conversation access (REQUIRED)**

```bash
# This is required for agent_end, llm_input, and llm_output hooks to work
openclaw config set plugins.entries.langfuse-tracer.hooks.allowConversationAccess true
```

4. **Configure via openclaw.json**

```bash
# Set your Langfuse credentials (one project, applied to every agent)
openclaw config set plugins.entries.langfuse-tracer.config.credentials \
  '[{"publicKey":"pk-lf-xxx","secretKey":"sk-lf-xxx","baseUrl":"http://langfuse-web:3000"}]'

# Restart gateway
openclaw gateway restart
```

Need different agents (or teams) to land in different Langfuse projects instead? See [Multi-Project Credentials](#multi-project-credentials-per-agent-routing) below.

5. **Verify installation**

```bash
openclaw plugins list | grep langfuse
```

You should see:

```
[langfuse-tracer] Tracking all agents
[langfuse-tracer] Langfuse tracing enabled → http://langfuse-web:3000
```

## ⚙️ Configuration

### ⚠️ Required: Enable Conversation Access

**IMPORTANT**: This plugin uses conversation access hooks (`agent_end`, `llm_input`, `llm_output`) that require explicit permission.

```bash
# This must be set for the plugin to work
openclaw config set plugins.entries.langfuse-tracer.hooks.allowConversationAccess true
```

**Why is this required?**

Conversation access hooks can read sensitive data:
- Full conversation history
- System prompts and agent instructions
- User inputs and assistant outputs
- Token usage and model information

OpenClaw requires explicit permission to ensure you trust the plugin with this data.

### Plugin Configuration via openclaw.json

All configuration is managed via `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "langfuse-tracer": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "logLevel": "info",
          "credentials": [
            {
              "publicKey": "pk-lf-xxx",
              "secretKey": "sk-lf-xxx",
              "baseUrl": "http://langfuse-web:3000"
            }
          ],
          "trackedAgents": [],
          "limits": {
            "userInput": 2000,
            "assistantOutput": 10000,
            "systemPrompt": 20000,
            "history": 5000,
            "toolParams": 500,
            "toolResult": 1000
          }
        }
      }
    }
  }
}
```

### Using CLI

```bash
# STEP 1: Enable conversation access (REQUIRED)
openclaw config set plugins.entries.langfuse-tracer.hooks.allowConversationAccess true

# STEP 2: Set Langfuse credentials
openclaw config set plugins.entries.langfuse-tracer.config.credentials \
  '[{"publicKey":"pk-lf-xxx","secretKey":"sk-lf-xxx","baseUrl":"http://langfuse-web:3000"}]'

# STEP 3: Optional - Enable debug logging
openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"

# STEP 4: Optional - Track specific agents (empty = track all)
openclaw config set plugins.entries.langfuse-tracer.config.trackedAgents '["prod-agent", "fais-agent"]'

# STEP 5: Optional - Customize data limits
openclaw config set plugins.entries.langfuse-tracer.config.limits.userInput 5000
openclaw config set plugins.entries.langfuse-tracer.config.limits.assistantOutput 20000

# STEP 6: Restart gateway to apply changes
openclaw gateway restart
```

### Multi-Project Credentials (per-agent routing)

`credentials` is a **list** of Langfuse projects. Each entry can be scoped to specific agents via `agentIds`; an entry with no `agentIds` (or an empty list) is the **default/catch-all** group used for any agent not matched by a more specific entry. This lets different agents/teams send traces to different Langfuse projects from the same plugin instance, instead of every agent sharing one project.

```bash
openclaw config set plugins.entries.langfuse-tracer.config.credentials '[
  {"publicKey":"pk-lf-teamA","secretKey":"sk-lf-teamA","agentIds":["teamA-agent"]},
  {"publicKey":"pk-lf-teamB","secretKey":"sk-lf-teamB","agentIds":["teamB-agent"]},
  {"publicKey":"pk-lf-default","secretKey":"sk-lf-default"}
]'
openclaw gateway restart
```

Resolution order for a given agent's trace, at `before_agent_start`:

1. The first `credentials[]` entry whose `agentIds` includes that agent's ID.
2. Otherwise, the first entry with no `agentIds` (or an empty list) — the default/catch-all group.
3. Otherwise, the trace is skipped entirely (no group matched, nothing sent to Langfuse).

**Backward compatibility**: the older single-project shorthand, `config.langfuse.{publicKey,secretKey,baseUrl}`, still works. If `credentials` doesn't already define a catch-all entry, `langfuse` (if set) is folded in as one. You only need `credentials` for new, multi-project setups — a single-project config can keep using either form.

### Configuration Reference

#### Required Settings

| Config Key                | Description                                                                        | Example                          |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| `credentials`              | Array of Langfuse credential groups (see [Multi-Project Credentials](#multi-project-credentials-per-agent-routing)); at least one group (or the deprecated `langfuse` object) must be configured | see example above |
| `credentials[].publicKey`  | Langfuse project public key for this group                                          | `pk-lf-xxx`                       |
| `credentials[].secretKey`  | Langfuse project secret key for this group                                          | `sk-lf-xxx`                       |

#### Optional Settings

| Config Key                | Description                                                          | Default                  |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `credentials[].baseUrl`    | Langfuse server URL for this group                                     | `http://172.21.0.1:3050` |
| `credentials[].agentIds`   | Agent IDs this group applies to; omit/empty = default/catch-all group  | _(none — catch-all)_     |
| `langfuse.*`               | Deprecated single-project shorthand; same shape as one `credentials[]` entry, minus `agentIds`. Folded in as the catch-all group only if `credentials` defines none | _(unset)_ |
| `logLevel`               | Log level: `info` or `debug`              | `info`                   |
| `trackedAgents`          | Array of agent IDs to trace (empty = all) | `[]`                     |
| `limits.userInput`       | Max chars for user input                  | `2000`                   |
| `limits.assistantOutput` | Max chars for assistant output            | `10000`                  |
| `limits.systemPrompt`    | Max chars for system prompt               | `20000`                  |
| `limits.history`         | Max chars for conversation history (JSON) | `5000`                   |
| `limits.toolParams`      | Max chars for tool parameters             | `500`                    |
| `limits.toolResult`      | Max chars for tool result                 | `1000`                   |

## 📊 What Gets Traced

### Data Model Overview

The plugin follows Langfuse's observability data model:

```
Trace (one agent run)
└─ Generation (LLM interaction session)
   ├─ Span (tool_call_1)
   ├─ Span (tool_call_2)
   └─ Span (tool_call_N)
```

**⚠️ Important Limitation:**

Due to OpenClaw's hook architecture, the plugin captures the agent run as a **single Generation** with all tool calls nested underneath. While the agent internally makes multiple LLM calls to decide which tools to use, these intermediate calls are not exposed through separate `llm_input`/`llm_output` hooks.

This means:

- ✅ You can see **all tool calls** with precise timing and parameters
- ✅ You get **total token usage** (accumulated from all LLM calls)
- ❌ You cannot see individual LLM decision cycles separately

For example, an agent that reads files → analyzes → executes commands will show:

- 1 Trace = entire agent run
- 1 Generation = all LLM interactions combined
- 7 Spans = each tool call (read × 2, exec × 2, process × 2, write × 1)

See [INVESTIGATION.md](INVESTIGATION.md) for technical details and future enhancement plans.

### For Each Agent Turn

#### 1. Trace Record

- **Trace ID**: Unique identifier
- **Session ID**: Groups related conversations
- **User ID**: Agent identifier
- **Tags**: `openclaw`, agent ID, provider, model
- **Input**: Complete context
  - User's original message
  - Full system prompt (including AGENTS.md)
  - Conversation history (JSON format)
- **Output**: Full response
  - Assistant's text response
  - All tool calls with results
- **Metadata**:
  - Success status
  - Error messages (if any)
  - Message count
  - Tool calls count
  - Images count
  - History messages count

#### 2. Generation Record

- **Generation ID**: Unique identifier
- **Model**: Actual model used
- **Timestamps**: Start and end times
- **Token Usage**:
  - Input tokens
  - Output tokens
  - Cache read/write (if supported)
- **Duration**: Execution time in milliseconds
- **Tool Metadata**: List of tools used with timing

### Example Tool Call Format

```markdown
### Tool Calls (3)

#### 1. exec

- Duration: 234ms
- Params: {"command":"ls -la"}
- Result: {"stdout":"total 48\ndrwxr-xr-x..."}

#### 2. read

- Duration: 156ms
- Params: {"path":"IDENTITY.md"}
- Result: "# Identity\n..."

#### 3. execute_sql

- Duration: 789ms
- Params: {"query":"SELECT \* FROM..."}
- Error: "Connection timeout"
```

## 🎯 Use Cases

### 1. Debugging Agent Behavior

- View complete system prompts to understand how the agent was instructed
- See exactly what context was available (AGENTS.md content, conversation history)
- Trace tool execution flow and identify bottlenecks

### 2. Performance Optimization

- Analyze token usage across different agents and models
- Identify slow tool calls
- Optimize system prompt length

### 3. Cost Tracking

- Monitor token consumption per agent
- Track which agents/conversations are most expensive
- Analyze cache hit rates (if supported by provider)

### 4. Quality Assurance

- Review agent responses in production
- Identify failure patterns
- Validate tool call accuracy

### 5. Compliance & Audit

- Complete audit trail of agent interactions
- Self-hosted data for privacy compliance
- Searchable trace history

## 🔍 Viewing Traces in Langfuse

1. **Access Langfuse UI**

   ```
   http://your-langfuse-url:3000
   ```

2. **Navigate to Traces**
   - Click on "Traces" in the left sidebar
   - You'll see all OpenClaw agent turns

3. **Filter by Agent**
   - Use tags: `openclaw`, `prod-agent`, etc.
   - Filter by time range, model, or provider

4. **Drill Down**
   - Click on a trace to see full details
   - **Input** tab: System prompt + user input + history
   - **Output** tab: Assistant response + tool calls
   - **Metadata** tab: Performance metrics

5. **Analyze Patterns**
   - Use Langfuse's analytics to track:
     - Average response time per agent
     - Token usage trends
     - Most frequently used tools
     - Error rates

## 🛠️ Troubleshooting

### No Traces Appearing

1. **Check conversation access is enabled** (most common issue)

   ```bash
   openclaw config get plugins.entries.langfuse-tracer.hooks
   ```
   
   Should show:
   ```json
   {
     "allowConversationAccess": true
   }
   ```
   
   If not set or shows `Config path not found`, enable it:
   ```bash
   openclaw config set plugins.entries.langfuse-tracer.hooks.allowConversationAccess true
   openclaw gateway restart
   ```
   
   **Symptom**: You see `after_tool_call` logs but NO `agent_end` logs.

2. **Check plugin is installed**

   ```bash
   openclaw plugins list | grep langfuse
   ```

3. **Verify configuration**

   ```bash
   openclaw config get plugins.entries.langfuse-tracer.config
   ```

4. **Enable debug mode**

   ```bash
   openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"
   openclaw gateway restart
   ```

5. **Check gateway logs**

   ```bash
   tail -f ~/.openclaw/logs/gateway-*.log | grep langfuse
   ```

   You should see:

   ```
   [langfuse-tracer] Tracking all agents
   [langfuse-tracer] Langfuse tracing enabled → http://...
      [langfuse-tracer] [DEBUG] before_agent_start: ...
   [langfuse-tracer] [DEBUG] llm_input: ...
   [langfuse-tracer] [DEBUG] llm_output: ...
   [langfuse-tracer] [DEBUG] agent_end: ...    <-- This should appear!
   [langfuse-tracer] Successfully sent trace for agent "prod-agent" (...)
   ```

6. **Test Langfuse connectivity**
   ```bash
   curl http://langfuse-web:3000/api/public/health
   ```

### Traces for Wrong Agent

Check your `trackedAgents` configuration:

```bash
openclaw config get plugins.entries.langfuse-tracer.config.trackedAgents
openclaw config get agents.list
```

Make sure agent IDs match exactly.

### Ingestion Failures

Check logs for error messages:

```bash
tail -100 ~/.openclaw/logs/gateway-*.log | grep "Ingestion failed"
```

Common causes:

- Incorrect credentials
- Network connectivity issues
- Langfuse server down
- Payload too large (increase limits in Langfuse)

## 🏗️ Architecture

```
┌─────────────────┐
│  OpenClaw Agent │
└────────┬────────┘
         │ Events:
         │ - before_agent_start
         │ - llm_input
         │ - llm_output
         │ - before_tool_call
         │ - after_tool_call
         │ - agent_end
         ↓
┌─────────────────┐
│ Langfuse Tracer │
│    (Plugin)     │
├─────────────────┤
│ • Collects data │
│ • Builds trace  │
│ • Sends batch   │
└────────┬────────┘
         │ POST /api/public/ingestion
         │ (Basic Auth)
         ↓
┌─────────────────┐
│    Langfuse     │
│   (Self-hosted) │
├─────────────────┤
│ • Stores traces │
│ • Analyzes data │
│ • Shows UI      │
└─────────────────┘
```

### Event Flow

1. **before_agent_start** → Capture initial prompt
2. **llm_input** → Capture system prompt, history, model
3. **before_tool_call** → Record tool invocation
4. **after_tool_call** → Record tool result and timing
5. **llm_output** → Capture token usage
6. **agent_end** → Assemble and send complete trace

### Data Limits

To prevent oversized payloads, the plugin truncates data at configurable limits.

#### Default Limits

| Data Type            | Default      | Config Key               |
| -------------------- | ------------ | ------------------------ |
| System prompt        | 20,000 chars | `limits.systemPrompt`    |
| Conversation history | 5,000 chars  | `limits.history`         |
| User input           | 2,000 chars  | `limits.userInput`       |
| Assistant output     | 10,000 chars | `limits.assistantOutput` |
| Tool parameters      | 500 chars    | `limits.toolParams`      |
| Tool result          | 1,000 chars  | `limits.toolResult`      |

#### Customizing Limits

You can adjust these limits via openclaw.json or CLI:

```bash
# Increase system prompt limit
openclaw config set plugins.entries.langfuse-tracer.config.limits.systemPrompt 50000

# Increase assistant output limit
openclaw config set plugins.entries.langfuse-tracer.config.limits.assistantOutput 20000

# Restart gateway
openclaw gateway restart
```

**Note**: Larger limits may result in:

- Higher network bandwidth usage
- Increased Langfuse database storage
- Potential ingestion failures if payload exceeds Langfuse limits

## 🔐 Security & Privacy

### Data Retention

- All data is sent to **your self-hosted** Langfuse instance
- You control data retention policies
- No data leaves your infrastructure

### Authentication

- Uses Basic Auth (base64 encoded credentials)
- Credentials stored securely in openclaw.json
- Never logged by the plugin

### Data Sanitization

- Consider sanitizing sensitive data in:
  - System prompts
  - Tool parameters
  - Tool results
- Implement custom filters if needed (fork this plugin)

## 📦 File Structure

```
langfuse-tracer/
├── README.md              # This file
├── package.json           # Plugin metadata (main/exports point at dist/)
├── tsconfig.json           # Build config (tsc)
├── openclaw.plugin.json   # Plugin config schema
├── index.ts               # Plugin entry point (source)
├── api.ts                 # Type exports (source)
├── src/
│   └── tracer.ts          # Core implementation (source)
├── dist/                  # Compiled output — this is what OpenClaw actually loads
├── HOOK.md                # Technical documentation
```

## 🔧 Building From Source

**OpenClaw never executes the TypeScript source directly.** `package.json`'s `main`/`exports` point at `./dist/index.js`, and `plugins.load.paths`/`openclaw plugins install` resolve the plugin through those fields — so only compiled output in `dist/` is ever loaded, not `index.ts`/`api.ts`/`src/tracer.ts`.

`dist/` is committed to this repo, so a fresh clone or `openclaw plugins install` works immediately without building anything. You only need to build when you **edit the source** (`index.ts`, `api.ts`, or anything under `src/`) — until you rebuild, OpenClaw keeps running whatever `dist/` already contains, silently ignoring your source edit.

```bash
cd langfuse-tracer

# Install the one build-time dependency (TypeScript itself; the plugin has
# zero *runtime* dependencies — see Features above)
npm install

# Compile index.ts / api.ts / src/*.ts → dist/
npm run build

# Remove dist/ entirely, if you want a clean rebuild
npm run clean
```

After building, restart (or reinstall) so OpenClaw picks up the new `dist/`:

```bash
openclaw gateway restart
# or, if installed with `-l` (symlinked): openclaw plugins install . -l
```

If you're committing a source change, commit the regenerated `dist/*` files in the same change — otherwise anyone else's checkout (or your running deployment) keeps executing the old compiled code even though `src/` has moved on.

### Expected build warnings (safe to ignore)

Building this plugin **outside** a real OpenClaw installation — i.e. running `tsc` in this folder standalone, without the `openclaw` package available for type resolution — always prints something like:

```
api.ts:1:63 - error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry' or its corresponding type declarations.
index.ts:1:35 - error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry' or its corresponding type declarations.
index.ts:8:12 - error TS7006: Parameter 'api' implicitly has an 'any' type.
src/tracer.ts:346:35 - error TS7006: Parameter 'event' implicitly has an 'any' type.
... (one more TS7006 pair per api.on(...) handler)
```

This is expected and has been present since the initial release — `index.ts`/`api.ts` import a subpath (`openclaw/plugin-sdk/plugin-entry`) that only resolves inside a real OpenClaw checkout/install, not in this submodule's own isolated `npm install`. Once that one import can't be resolved, `api`'s type collapses to `any`, and every `api.on(...)` handler cascades into TS7006 from there — it's one root cause, not several independent bugs.

`tsc` still exits non-zero (`npm run build` will report failure to any script checking its exit code), **but it still emits working JS into `dist/`** — `tsconfig.json` sets `"noEmitOnError": false` specifically so this doesn't block the build. Verify by diffing `dist/` after building; if your source edit shows up there, the build did what it needed to.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

### Development Setup

```bash
# Clone the repo
git clone https://github.com/syao-dai/openclaw_langfuse_tracer.git
cd openclaw_langfuse_tracer
npm install

# Install in development mode
openclaw plugins install .

# Make changes to src/tracer.ts

# Rebuild — see "Building From Source" above; skipping this step means
# your change has no effect, since OpenClaw only ever loads dist/
npm run build

# Reload
openclaw gateway restart

# Check logs
tail -f ~/.openclaw/logs/gateway-*.log | grep langfuse
```

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [OpenClaw](https://github.com/OpenClaw/openclaw) - Open-source AI agent framework
- [Langfuse](https://langfuse.com/) - Open-source LLM observability platform

## 📧 Support

- **Issues**: [GitHub Issues](https://github.com/syao-dai/openclaw_langfuse_tracer/issues)
- **OpenClaw**: [OpenClaw Discord](https://discord.gg/openclaw)

## 🗺️ Roadmap

- [ ] Support for custom trace attributes
- [ ] Configurable data sanitization rules
- [ ] Batch size optimization
- [ ] Retry logic with exponential backoff
- [ ] Support for multiple Langfuse projects
- [ ] Performance benchmarking dashboard
- [ ] Integration with OpenClaw analytics

## 📊 Changelog

### v2026.4.7 (Current)

- ✅ **Plugin-based configuration** - All settings managed via openclaw.json (no environment variables needed)
- ✅ **Debug logging** - Configurable log level (`info` or `debug`) for troubleshooting
- ✅ **Configurable data limits** - All truncation limits configurable via plugin config
- ✅ Complete system prompt capture (configurable, default 20K chars)
- ✅ Conversation history tracking (configurable, default 5K chars JSON)
- ✅ Tool call monitoring with timing
- ✅ Token usage tracking (input/output/cache)
- ✅ Selective agent tracking via config
- ✅ Production-ready with error handling
- ✅ Zero npm dependencies

### v2026.3.26

- Initial release with environment variable configuration

---

**Built with ❤️ for the OpenClaw community**

⭐ If this plugin helps you, please star the repo!
