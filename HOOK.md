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
- `src/service.ts` - Service implementation with lifecycle management
- `api.ts` - Type exports for Plugin SDK
- `openclaw.plugin.json` - Plugin metadata and config schema
- `package.json` - Package configuration with OpenClaw extensions

## Configuration

This plugin supports two levels of configuration:

### 1. Environment Variables (Required)

These must be set in the `openclaw-gateway` container:

| Variable              | Description                 | Example                                    |
| --------------------- | --------------------------- | ------------------------------------------ |
| `LANGFUSE_PUBLIC_KEY` | Langfuse project public key | Same as `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` |
| `LANGFUSE_SECRET_KEY` | Langfuse project secret key | Same as `LANGFUSE_INIT_PROJECT_SECRET_KEY` |
| `LANGFUSE_BASE_URL`   | Langfuse server URL         | `http://172.21.0.1:3050` (Docker host)     |

### 2. Plugin Configuration (Optional)

Configure which agents to track in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "langfuse-tracer": {
        "enabled": true,
        "config": {
          "trackedAgents": ["agent-1", "agent-2"]
        }
      }
    }
  }
}
```

**Plugin Configuration Options:**

| Option          | Type       | Description                | Default           |
| --------------- | ---------- | -------------------------- | ----------------- |
| `trackedAgents` | `string[]` | List of agent IDs to trace | `[]` (all agents) |

**Behavior:**

- **Empty or omitted** (`[]` or not set): Traces **all agents**
- **Specific IDs** (`["my-agent", "prod-agent"]`): Only traces the specified agents

### Example: Track Specific Agent

```json
{
  "agents": {
    "list": [
      { "id": "prod-agent", "name": "Production Agent" },
      { "id": "dev-agent", "name": "Development Agent" }
    ]
  },
  "plugins": {
    "entries": {
      "langfuse-tracer": {
        "enabled": true,
        "config": {
          "trackedAgents": ["prod-agent"]
        }
      }
    }
  }
}
```

In this example, only `prod-agent` conversations will be sent to Langfuse.

### Example Docker Compose Configuration

```yaml
services:
  openclaw-gateway:
    environment:
      - LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
      - LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
      - LANGFUSE_BASE_URL=http://172.21.0.1:3050
```

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
openclaw plugins install ./langfuse-tracer
```

## Verification

After installation, check the logs:

- ✅ **Enabled**: `[langfuse-tracer] Langfuse tracing enabled → http://...`
- ⚠️ **Disabled**: `[langfuse-tracer] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled`

## Troubleshooting

### Tracing not working

1. Verify environment variables are set in openclaw-gateway container
2. Check Langfuse server is accessible from container
3. Verify public/secret keys match your Langfuse project
4. Check openclaw-gateway logs for `[langfuse-tracer]` messages

### Ingestion failures

- Check `[langfuse-tracer] Ingestion failed` warnings in logs
- Verify LANGFUSE_BASE_URL is correct (use Docker host gateway IP for containerized Langfuse)
- Test connectivity: `curl ${LANGFUSE_BASE_URL}/api/public/health`

## License

Same as OpenClaw project
