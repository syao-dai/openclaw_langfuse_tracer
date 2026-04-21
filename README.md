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

### Production Ready
- 🏠 **Self-Hosted** - All data stays in your infrastructure
- 🚀 **Zero Dependencies** - Uses native `fetch` API, no npm packages required
- ⚡ **Non-Blocking** - Asynchronous sending with error handling
- 🎯 **Selective Tracing** - Configure which agents to track
- 🔒 **Secure** - Basic Auth with environment variable credentials

## 📸 Screenshots

### Langfuse Trace View
Your OpenClaw agent interactions appear in Langfuse with complete context:

```
Trace: openclaw-agent-turn
├─ Input
│  ├─ User Input: "Analyze Q1 sales data"
│  ├─ System Prompt: "You are a personal assistant..."
│  └─ Conversation History: [...previous messages]
│
├─ Output
│  ├─ Assistant Response: "I'll analyze the data..."
│  └─ Tool Calls
│     ├─ 1. read (333ms) - Read IDENTITY.md
│     ├─ 2. read (349ms) - Read USER.md  
│     ├─ 3. exec (379ms) - Run SQL query
│     └─ ... (results included)
│
└─ Metadata
   ├─ Provider: amazon-bedrock
   ├─ Model: claude-sonnet-4
   ├─ Tokens: 57,298 (input: 52,101, output: 5,197)
   └─ Tools: 6 calls
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

3. **Configure via openclaw.json**

```bash
# Set your Langfuse credentials
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.publicKey "pk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.secretKey "sk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.baseUrl "http://langfuse-web:3000"

# Restart gateway
openclaw gateway restart
```

4. **Verify installation**

```bash
openclaw plugins list | grep langfuse
```

You should see:
```
[langfuse-tracer] Tracking all agents
[langfuse-tracer] Langfuse tracing enabled → http://langfuse-web:3000
```

## ⚙️ Configuration

### Plugin Configuration via openclaw.json

All configuration is managed via `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "langfuse-tracer": {
        "enabled": true,
        "config": {
          "logLevel": "info",
          "langfuse": {
            "publicKey": "pk-lf-xxx",
            "secretKey": "sk-lf-xxx",
            "baseUrl": "http://langfuse-web:3000"
          },
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
# Set Langfuse credentials
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.publicKey "pk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.secretKey "sk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.baseUrl "http://langfuse-web:3000"

# Enable debug logging (optional)
openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"

# Track specific agents (optional, empty = track all)
openclaw config set plugins.entries.langfuse-tracer.config.trackedAgents '["prod-agent", "fais-agent"]'

# Customize data limits (optional)
openclaw config set plugins.entries.langfuse-tracer.config.limits.userInput 5000
openclaw config set plugins.entries.langfuse-tracer.config.limits.assistantOutput 20000

# Restart gateway to apply changes
openclaw gateway restart
```

### Configuration Reference

#### Required Settings

| Config Key | Description | Example |
|------------|-------------|---------|
| `langfuse.publicKey` | Langfuse project public key | `pk-lf-xxx` |
| `langfuse.secretKey` | Langfuse project secret key | `sk-lf-xxx` |

#### Optional Settings

| Config Key | Description | Default |
|------------|-------------|---------|
| `langfuse.baseUrl` | Langfuse server URL | `http://172.21.0.1:3050` |
| `logLevel` | Log level: `info` or `debug` | `info` |
| `trackedAgents` | Array of agent IDs to trace (empty = all) | `[]` |
| `limits.userInput` | Max chars for user input | `2000` |
| `limits.assistantOutput` | Max chars for assistant output | `10000` |
| `limits.systemPrompt` | Max chars for system prompt | `20000` |
| `limits.history` | Max chars for conversation history (JSON) | `5000` |
| `limits.toolParams` | Max chars for tool parameters | `500` |
| `limits.toolResult` | Max chars for tool result | `1000` |

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
- Params: {"query":"SELECT * FROM..."}
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

1. **Check plugin is installed**
   ```bash
   openclaw plugins list | grep langfuse
   ```

2. **Verify configuration**
   ```bash
   openclaw config get plugins.entries.langfuse-tracer.config
   ```

3. **Enable debug mode**
   ```bash
   openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"
   openclaw gateway restart
   ```

4. **Check gateway logs**
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
   [langfuse-tracer] [DEBUG] agent_end: ...
   [langfuse-tracer] Successfully sent trace for agent "prod-agent" (...)
   ```

5. **Test Langfuse connectivity**
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

| Data Type | Default | Config Key |
|-----------|---------|------------|
| System prompt | 20,000 chars | `limits.systemPrompt` |
| Conversation history | 5,000 chars | `limits.history` |
| User input | 2,000 chars | `limits.userInput` |
| Assistant output | 10,000 chars | `limits.assistantOutput` |
| Tool parameters | 500 chars | `limits.toolParams` |
| Tool result | 1,000 chars | `limits.toolResult` |

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
├── package.json           # Plugin metadata
├── openclaw.plugin.json   # Plugin config schema
├── index.ts               # Plugin entry point
├── api.ts                 # Type exports
├── src/
│   └── tracer.ts          # Core implementation
├── HOOK.md                # Technical documentation
```

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

# Install in development mode
openclaw plugins install .

# Make changes to src/tracer.ts

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
