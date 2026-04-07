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
git clone https://github.com/syao-dai/openclaw_langfuse_tracer.git
```

2. **Set environment variables**

Add to your `docker-compose.yml` (or container environment):

```yaml
services:
  openclaw-gateway:
    environment:
      - LANGFUSE_PUBLIC_KEY=pk-lf-xxx
      - LANGFUSE_SECRET_KEY=sk-lf-xxx
      - LANGFUSE_BASE_URL=http://langfuse-web:3000
```

3. **Install the plugin**

```bash
openclaw plugins install /path/to/langfuse-tracer
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

### Basic Setup (Track All Agents)

No additional configuration needed. The plugin will track all agents by default.

### Advanced: Track Specific Agents

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "langfuse-tracer": {
        "enabled": true,
        "config": {
          "trackedAgents": ["prod-agent", "fais-agent"]
        }
      }
    }
  }
}
```

Or use the CLI:

```bash
openclaw config set plugins.entries.langfuse-tracer.config.trackedAgents '["prod-agent"]'
openclaw gateway restart
```

### Environment Variables

#### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse project public key | `pk-lf-...` |
| `LANGFUSE_SECRET_KEY` | Langfuse project secret key | `sk-lf-...` |

#### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LANGFUSE_BASE_URL` | Langfuse server URL | `http://172.21.0.1:3050` |
| `LANGFUSE_LIMIT_USER_INPUT` | Max characters for user input | `2000` |
| `LANGFUSE_LIMIT_ASSISTANT_OUTPUT` | Max characters for assistant output | `10000` |
| `LANGFUSE_LIMIT_SYSTEM_PROMPT` | Max characters for system prompt | `20000` |
| `LANGFUSE_LIMIT_HISTORY` | Max characters for conversation history (JSON) | `5000` |
| `LANGFUSE_LIMIT_TOOL_PARAMS` | Max characters for tool parameters | `500` |
| `LANGFUSE_LIMIT_TOOL_RESULT` | Max characters for tool result | `1000` |

## 📊 What Gets Traced

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

2. **Verify environment variables**
   ```bash
   # In the gateway container
   echo $LANGFUSE_PUBLIC_KEY
   echo $LANGFUSE_SECRET_KEY
   echo $LANGFUSE_BASE_URL
   ```

3. **Check gateway logs**
   ```bash
   tail -f ~/.openclaw/logs/gateway-*.log | grep langfuse
   ```

   You should see:
   ```
   [langfuse-tracer] Tracking all agents
   [langfuse-tracer] Langfuse tracing enabled → http://...
   [langfuse-tracer] Successfully sent trace for agent "prod-agent" (...)
   ```

4. **Test Langfuse connectivity**
   ```bash
   # From gateway container
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

| Data Type | Default | Environment Variable |
|-----------|---------|---------------------|
| System prompt | 20,000 chars | `LANGFUSE_LIMIT_SYSTEM_PROMPT` |
| Conversation history | 5,000 chars | `LANGFUSE_LIMIT_HISTORY` |
| User input | 2,000 chars | `LANGFUSE_LIMIT_USER_INPUT` |
| Assistant output | 10,000 chars | `LANGFUSE_LIMIT_ASSISTANT_OUTPUT` |
| Tool parameters | 500 chars | `LANGFUSE_LIMIT_TOOL_PARAMS` |
| Tool result | 1,000 chars | `LANGFUSE_LIMIT_TOOL_RESULT` |

#### Customizing Limits

You can adjust these limits via environment variables:

```yaml
services:
  openclaw-gateway:
    environment:
      - LANGFUSE_PUBLIC_KEY=pk-lf-xxx
      - LANGFUSE_SECRET_KEY=sk-lf-xxx
      - LANGFUSE_BASE_URL=http://langfuse-web:3000
      # Custom data limits
      - LANGFUSE_LIMIT_SYSTEM_PROMPT=50000
      - LANGFUSE_LIMIT_ASSISTANT_OUTPUT=20000
      - LANGFUSE_LIMIT_TOOL_RESULT=5000
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
- Credentials stored as environment variables
- Never logged or persisted by the plugin

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

### v2026.3.28 (Current)
- ✅ **Configurable data limits** - All truncation limits now configurable via environment variables
- ✅ Complete system prompt capture (default 20K chars)
- ✅ Conversation history tracking (default 5K chars JSON)
- ✅ Tool call monitoring with timing
- ✅ Token usage tracking (input/output/cache)
- ✅ Selective agent tracking via config
- ✅ Production-ready with error handling
- ✅ Zero npm dependencies

### v2026.3.26
- Initial release with fixed data limits

---

**Built with ❤️ for the OpenClaw community**

⭐ If this plugin helps you, please star the repo!
