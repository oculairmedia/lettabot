# Deploy LettaBot on Railway

Railway provides a simple way to deploy LettaBot to the cloud with persistent storage and automatic restarts.

## Quick Start

1. Click the Deploy button in the README (or create a new project from the [lettabot repo](https://github.com/letta-ai/lettabot))
2. Set the required environment variables
3. Deploy

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `LETTA_API_KEY` | Your API key from [app.letta.com](https://app.letta.com) |

Plus at least ONE channel:

| Channel | Variable | How to get it |
|---------|----------|---------------|
| Telegram | `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) on Telegram |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Create app at [api.slack.com/apps](https://api.slack.com/apps) |
| Discord | `DISCORD_BOT_TOKEN` | Create app at [discord.com/developers](https://discord.com/developers/applications) |

## Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LETTA_BASE_URL` | `https://api.letta.com` | For self-hosted Letta servers |
| `AGENT_NAME` | `LettaBot` | Name for your agent |
| `MODEL` | `zai/glm-4.7` | Model to use (free) |
| `WORKING_DIR` | `/tmp/lettabot` | Data directory (set to `/data` with volume) |
| `TELEGRAM_DM_POLICY` | `pairing` | Access control: `pairing`, `allowlist`, or `open` |
| `SLACK_ALLOWED_USERS` | (empty) | Comma-separated Slack user IDs |
| `DISCORD_DM_POLICY` | `pairing` | Access control: `pairing`, `allowlist`, or `open` |

## Persistent Storage

To persist the agent ID and session data across redeploys:

1. In Railway, go to your service settings
2. Add a **Volume** mounted at `/data`
3. Set `WORKING_DIR=/data` in your environment variables

This ensures:
- Agent ID is preserved (no duplicate agents)
- WhatsApp session persists (if using WhatsApp)
- Cron jobs are saved

## Self-Hosted Letta Server

To use a self-hosted Letta server instead of Letta Cloud:

1. Set `LETTA_BASE_URL` to your server URL (e.g., `http://your-letta-service:8283`)
2. Leave `LETTA_API_KEY` empty (or set it if your server requires auth)

You can run Letta as another Railway service:

```bash
# In another Railway service, use the official Letta Docker image
docker.io/letta/letta:latest
```

## Channel-Specific Notes

### Telegram (Recommended)
Easiest channel to set up. Just need the bot token from @BotFather.

### Slack
Requires two tokens:
- **Bot Token** (`xoxb-...`) - OAuth & Permissions page
- **App Token** (`xapp-...`) - Basic Information > App-Level Tokens

Enable Socket Mode in your Slack app settings.

### Discord
Requires:
- Bot token from the Bot section
- **Message Content Intent** enabled under Privileged Gateway Intents

### WhatsApp (Advanced)
WhatsApp requires a QR code scan on first setup:

1. Deploy to Railway
2. View the deployment logs
3. Look for the QR code in the logs
4. Scan with your phone (WhatsApp > Settings > Linked Devices)

With a volume mounted, subsequent deploys won't need re-scanning.

Set `WHATSAPP_ENABLED=true` and optionally:
- `WHATSAPP_SELF_CHAT_MODE=true` for personal number (only responds to "Message Yourself")
- `WHATSAPP_SELF_CHAT_MODE=false` for dedicated bot number (responds to all)

### Signal
Signal is **not supported** on Railway as it requires the signal-cli daemon.

## Access Control

By default, LettaBot uses **pairing** mode:
1. Unauthorized users get a pairing code
2. You approve codes via the CLI

On Railway, you can't easily run CLI commands, so consider:
- **allowlist mode**: Set `TELEGRAM_DM_POLICY=allowlist` and `TELEGRAM_ALLOWED_USERS=123456789`
- **open mode**: Set `TELEGRAM_DM_POLICY=open` (not recommended for public bots)

To approve pairing codes, you can use Railway's shell feature or the Letta Code CLI connected to the same agent.

## Health Checks

LettaBot exposes a health endpoint at `/health` on the `PORT` environment variable (Railway sets this automatically).

## Troubleshooting

### "No config found" error
Make sure you have `LETTA_API_KEY` set AND at least one channel token.

### Agent keeps getting recreated
Mount a volume at `/data` and set `WORKING_DIR=/data` to persist the agent ID.

### WhatsApp disconnects frequently
This is normal during initial setup. Once paired and with a volume mounted, it should stabilize.

### Can't access pairing approval
Either:
- Use allowlist mode instead of pairing
- Use Railway's shell feature to run `lettabot pairing list`
- Connect via Letta Code CLI to the same agent
