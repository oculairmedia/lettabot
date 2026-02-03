# Railway Deployment

Deploy LettaBot to [Railway](https://railway.app) for always-on hosting.

## One-Click Deploy

1. Fork this repository
2. Connect to Railway
3. Set environment variables (see below)
4. Deploy!

**No local setup required.** LettaBot automatically finds or creates your agent by name.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LETTA_API_KEY` | Your Letta Cloud API key ([get one here](https://app.letta.com)) |

### Channel Configuration (at least one required)

**Telegram:**
```
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_DM_POLICY=pairing
```

**Discord:**
```
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_DM_POLICY=pairing
```

**Slack:**
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_NAME` | `LettaBot` | Agent name (used to find/create agent) |
| `MODEL` | `claude-sonnet-4-20250514` | Model to use |
| `LETTA_AGENT_ID` | - | Override auto-discovery with specific agent ID |
| `CRON_ENABLED` | `false` | Enable cron jobs |
| `HEARTBEAT_INTERVAL_MIN` | - | Enable heartbeats (minutes) |
| `HEARTBEAT_TARGET` | - | Target chat (e.g., `telegram:123456`) |
| `OPENAI_API_KEY` | - | For voice message transcription |

## How It Works

### Agent Discovery

On startup, LettaBot:
1. Checks for `LETTA_AGENT_ID` env var - uses if set
2. Otherwise, searches Letta Cloud for an agent named `AGENT_NAME` (default: "LettaBot")
3. If found, uses the existing agent (preserves memory!)
4. If not found, creates a new agent on first message

This means **your agent persists across deploys** without any manual ID copying.

### Build & Deploy

Railway automatically:
- Detects Node.js and installs dependencies
- Runs `npm run build` to compile TypeScript
- Runs `npm start` to start the server
- Sets the `PORT` environment variable
- Monitors `/health` endpoint

## Channel Limitations

| Channel | Railway Support | Notes |
|---------|-----------------|-------|
| Telegram | Yes | Full support |
| Discord | Yes | Full support |
| Slack | Yes | Full support |
| WhatsApp | No | Requires local QR pairing |
| Signal | No | Requires local device registration |

## Troubleshooting

### "No channels configured"

Set at least one channel token (TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, or SLACK tokens).

### Agent not found / wrong agent

- Check `AGENT_NAME` matches your intended agent
- Or set `LETTA_AGENT_ID` explicitly to use a specific agent
- Multiple agents with the same name? The most recently created one is used

### Health check failing

Check Railway logs for startup errors. Common issues:
- Missing `LETTA_API_KEY`
- Invalid channel tokens

## Deploy Button

Add this to your README to enable one-click deploys:

```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/YOUR_TEMPLATE_ID)
```
