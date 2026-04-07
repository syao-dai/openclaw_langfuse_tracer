# Langfuse Tracer

Sends OpenClaw agent traces to a self-hosted Langfuse instance for observability and monitoring.

## Features

- 🔍 **Full trace observability**: Captures every agent turn with input/output and token usage
- 🏠 **Self-hosted**: Works with your own Langfuse instance (no external dependencies)
- 🚀 **Zero npm packages**: Uses native fetch and Langfuse REST API directly
- 📊 **Session tracking**: Groups traces by session for conversation analysis
- ⚡ **Non-blocking**: Async sending with error handling to avoid impacting agent performance

## Architecture

This plugin follows the standard OpenClaw plugin architecture:

- `index.ts` - Plugin entry point using `definePluginEntry`
- `src/tracer.ts` - Core tracer implementation using plugin hooks
- `api.ts` - Type exports for Plugin SDK
- `openclaw.plugin.json` - Plugin metadata and config schema
- `package.json` - Package configuration with OpenClaw extensions

### Plugin Hooks

The plugin listens to these OpenClaw hook events:

- `before_agent_start` - Captures initial user prompt
- `llm_input` - Captures system prompt, history, and model info
- `llm_output` - Captures token usage and assistant response
- `before_tool_call` - Records tool invocation start
- `after_tool_call` - Records tool result and timing
- `agent_end` - Assembles and sends complete trace to Langfuse

## Configuration

All configuration is managed via `openclaw.json`. No environment variables needed.

### Plugin Configuration

Configure the plugin in `openclaw.json`:

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

# Set tracked agents (empty array = track all)
openclaw config set plugins.entries.langfuse-tracer.config.trackedAgents '["prod-agent"]'

# Enable debug logging
openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"

# Set custom limits (optional)
openclaw config set plugins.entries.langfuse-tracer.config.limits.userInput 5000

# Restart gateway
openclaw gateway restart
```

### Configuration Reference

#### Langfuse Connection

| Config Key | Description | Default |
| ---------- | ----------- | ------- |
| `langfuse.publicKey` | Langfuse project public key | *(required)* |
| `langfuse.secretKey` | Langfuse project secret key | *(required)* |
| `langfuse.baseUrl` | Langfuse server URL | `http://172.21.0.1:3050` |

#### Logging

| Config Key | Description | Default |
| ---------- | ----------- | ------- |
| `logLevel` | Log level: `info` or `debug` | `info` |

#### Data Limits

| Config Key | Description | Default |
| ---------- | ----------- | ------- |
| `limits.userInput` | Max chars for user input | `2000` |
| `limits.assistantOutput` | Max chars for assistant output | `10000` |
| `limits.systemPrompt` | Max chars for system prompt | `20000` |
| `limits.history` | Max chars for history JSON | `5000` |
| `limits.toolParams` | Max chars for tool params | `500` |
| `limits.toolResult` | Max chars for tool result | `1000` |

#### Agent Tracking

| Config Key | Description | Default |
| ---------- | ----------- | ------- |
| `trackedAgents` | Array of agent IDs to trace | `[]` (all agents) |

## Data Transmission

### Destination

All data is sent to: `${LANGFUSE_BASE_URL}/api/public/ingestion`

- **Method**: POST
- **Authentication**: Basic Auth (base64 encoded public/secret keys)
- **Format**: JSON batch ingestion

### Data Captured

For each agent turn, two records are created:

1. **Trace Record**:
   - Trace ID (UUID)
   - Session ID (from context)
   - User ID (agent ID)
   - Input text (max 2000 chars)
   - Output text (max 4000 chars)
   - Success status and error messages
   - Message count

2. **Generation Record**:
   - Generation ID (UUID)
   - Linked to trace
   - Token usage (input/output tokens)
   - Duration in milliseconds
   - Start and end timestamps

### Privacy & Security

- All data stays within your infrastructure (self-hosted)
- Authentication via Basic Auth
- Text truncation to prevent oversized payloads
- No external service dependencies

## Installation

```bash
# Install the plugin
openclaw plugins install /path/to/langfuse-tracer -l

# Configure credentials
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.publicKey "pk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.secretKey "sk-lf-xxx"
openclaw config set plugins.entries.langfuse-tracer.config.langfuse.baseUrl "http://langfuse-web:3000"

# Restart gateway
openclaw gateway restart
```

## Verification

After installation, check the logs:

- ✅ **Enabled**: `[langfuse-tracer] Langfuse tracing enabled → http://...`
- ⚠️ **Disabled**: `[langfuse-tracer] Langfuse credentials not configured — tracing disabled`

To see detailed event logs, enable debug mode:

```bash
openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"
openclaw gateway restart
```

You should see:
```
[langfuse-tracer] Debug mode enabled
[langfuse-tracer] [DEBUG] before_agent_start: ...
[langfuse-tracer] [DEBUG] llm_input: ...
[langfuse-tracer] [DEBUG] llm_output: ...
[langfuse-tracer] [DEBUG] agent_end: ...
```

## Troubleshooting

### Tracing not working

1. Verify configuration is set:
   ```bash
   openclaw config get plugins.entries.langfuse-tracer.config
   ```

2. Check Langfuse server is accessible:
   ```bash
   curl http://langfuse-web:3000/api/public/health
   ```

3. Enable debug logging:
   ```bash
   openclaw config set plugins.entries.langfuse-tracer.config.logLevel "debug"
   openclaw gateway restart
   ```

4. Check openclaw-gateway logs for `[langfuse-tracer]` messages

### Ingestion failures

- Check `[langfuse-tracer] Ingestion failed` warnings in logs
- Verify `langfuse.baseUrl` is correct
- Verify `langfuse.publicKey` and `langfuse.secretKey` match your Langfuse project
- Test connectivity: `curl ${LANGFUSE_BASE_URL}/api/public/health`

## License

Same as OpenClaw project
