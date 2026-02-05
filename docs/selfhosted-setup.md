# Connecting LettaBot to a Local Letta Server

Configure LettaBot to use your self-hosted Letta server instead of Letta Cloud.

## Configuration

Edit `lettabot.yaml` in your LettaBot directory:

```yaml
server:
  mode: selfhosted
  baseUrl: http://localhost:8283    # Your Letta server URL
  # apiKey: your-api-key            # Only if your server requires auth

agent:
  name: LettaBot
  model: gpt-4o                     # Must match a model your server supports

channels:
  telegram:
    enabled: true
    token: YOUR_TELEGRAM_BOT_TOKEN
    dmPolicy: pairing
```

**Key settings:**

| Field | Description |
|-------|-------------|
| `server.mode` | Must be `selfhosted` (not `cloud`) |
| `server.baseUrl` | Full URL to your Letta server (default port is 8283) |
| `server.apiKey` | Optional - only needed if your server requires authentication |
| `agent.model` | Model name that your server has configured (e.g., `gpt-4o`, `claude-sonnet-4`) |

## Network Examples

```yaml
# Local server on same machine
server:
  baseUrl: http://localhost:8283

# Server on another machine (use IP or hostname)
server:
  baseUrl: http://192.168.1.100:8283

# LettaBot in Docker, Letta server on host
server:
  baseUrl: http://host.docker.internal:8283
```

## Start LettaBot

```bash
lettabot server
```

Expected output:
```
[Config] Mode: selfhosted, Agent: LettaBot, Model: gpt-4o
Starting LettaBot...
=================================
LettaBot is running!
=================================
Agent ID: (will be created on first message)
```

On first message, LettaBot creates an agent on your server and saves the ID to `lettabot-agent.json`.

## Troubleshooting

### Connection Refused
```
Error: connect ECONNREFUSED 127.0.0.1:8283
```
Verify your Letta server is running: `curl http://localhost:8283/v1/health`

### Agent Stuck / Not Responding

**Tool approvals:** LettaBot disables tool approvals on startup, but if stuck:
```bash
# Check for approvals requiring action
curl http://YOUR_SERVER:8283/v1/agents/AGENT_ID/tools | jq '.[].requires_approval'
```

**Invalid conversation:** If conversation was deleted server-side:
```bash
# Clear stored conversation ID
cat lettabot-agent.json | jq 'del(.conversationId)' > tmp.json && mv tmp.json lettabot-agent.json
# Restart LettaBot
```

### Model Not Found
Ensure the model in your config matches what your Letta server has configured. Check your server's environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).

## Using an Existing Agent

To connect to an agent that already exists on your server:

```yaml
agent:
  id: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  # Existing agent ID
  name: LettaBot
  model: gpt-4o
```

Or set via environment: `LETTA_AGENT_ID=agent-xxx...`
