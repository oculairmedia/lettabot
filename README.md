# LettaBot

Your personal AI assistant that remembers everything across **Telegram, Slack, WhatsApp, and Signal**. Powered by [Letta Code](https://github.com/letta-ai/letta-code).

<img width="750" alt="lettabot-preview" src="https://github.com/user-attachments/assets/9f01b845-d5b0-447b-927d-ae15f9ec7511" />

## Features

- **Multi-Channel** - Chat seamlessly across Telegram, Slack, WhatsApp, and Signal
- **Unified Memory** - Single agent remembers everything from all channels
- **Persistent Memory** - Agent remembers conversations across sessions (days/weeks/months)
- **Local Tool Execution** - Agent can read files, search code, run commands on your machine
- **Heartbeat** - Periodic check-ins where the agent reviews tasks
- **Scheduling** - Agent can create one-off reminders and recurring tasks
- **Streaming Responses** - Real-time message updates as the agent thinks

## Quick Start

### Prerequisites

- Node.js 18+
- A Letta API key from [app.letta.com](https://app.letta.com) (or [self-hosted](https://docs.letta.com/guides/docker/) Letta server)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Install

```bash
# Clone the repository
git clone https://github.com/letta-ai/lettabot.git
cd lettabot

# Install dependencies
npm install

# Build and link the CLI globally
npm run build
npm link
```

#### Optional: self-hosted docker server 
You can use `lettabot` with a self-hosted Letta server with: 
```
docker run \
  -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data \
  -p 8283:8283 \
  -e OPENAI_API_KEY="your_openai_api_key" \
  letta/letta:latest
```
See the [documentation](https://docs.letta.com/guides/docker/) for more details on self-hosting and model configuration. 

### Setup

Run the interactive onboarding wizard:

```bash
lettabot onboard
```

This will guide you through:
1. Setting up your Letta API key (or self-hosted URL) 
2. Configuring Telegram (and optionally Slack, WhatsApp, Signal)
3. Enabling heartbeat and scheduled tasks

### Run

```bash
lettabot server
```

That's it! Message your bot on Telegram.

## CLI Commands

| Command | Description |
|---------|-------------|
| `lettabot onboard` | Interactive setup wizard |
| `lettabot server` | Start the bot server |
| `lettabot configure` | View and edit configuration |
| `lettabot skills status` | Show enabled and available skills |
| `lettabot destroy` | Delete all local data and start fresh |
| `lettabot help` | Show help |

## Multi-Channel Architecture

LettaBot uses a **single agent with a single conversation** across all channels:

```
Telegram ──┐
           ├──→ ONE AGENT ──→ ONE CONVERSATION
Slack ─────┤    (memory)      (chat history)
WhatsApp ──┘
```

- Start a conversation on Telegram
- Continue it on Slack
- Pick it up on WhatsApp
- The agent remembers everything!

## Channel Setup

| Channel | Guide | Requirements |
|---------|-------|--------------|
| Telegram | [Setup Guide](docs/getting-started.md) | Bot token from @BotFather |
| Slack | [Setup Guide](docs/slack-setup.md) | Slack app with Socket Mode |
| WhatsApp | [Setup Guide](docs/whatsapp-setup.md) | Phone with WhatsApp |
| Signal | [Setup Guide](docs/signal-setup.md) | signal-cli + phone number |

At least one channel is required. Telegram is the easiest to start with.

## Configuration

### Environment Variables (.env)

```bash
# if using the Letta API
LETTA_API_KEY=your_letta_api_key
# if using the self-hosted Docker image
LETTA_BASE_URL=http://localhost:8283

# Telegram (easiest to start)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_DM_POLICY=pairing  # pairing, allowlist, or open

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# WhatsApp (optional)
WHATSAPP_ENABLED=true

# Signal (optional)
SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX

# Scheduling (optional)
CRON_ENABLED=true

# Heartbeat - periodic check-ins (optional)
HEARTBEAT_INTERVAL_MIN=30
```

### Full Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `LETTA_API_KEY` | Yes | API key from app.letta.com |
| `TELEGRAM_BOT_TOKEN` | * | Bot token from @BotFather |
| `TELEGRAM_DM_POLICY` | No | pairing/allowlist/open (default: pairing) |
| `TELEGRAM_ALLOWED_USERS` | No | Comma-separated Telegram user IDs |
| `SLACK_BOT_TOKEN` | * | Slack bot token (xoxb-...) |
| `SLACK_APP_TOKEN` | * | Slack app token (xapp-...) |
| `WHATSAPP_ENABLED` | No | Set to `true` to enable WhatsApp |
| `SIGNAL_PHONE_NUMBER` | * | Phone number registered with signal-cli |
| `WORKING_DIR` | No | Agent workspace (default: `/tmp/lettabot`) |
| `CRON_ENABLED` | No | Enable scheduled tasks |
| `HEARTBEAT_INTERVAL_MIN` | No | Heartbeat interval in minutes (e.g., `30`) |
| `HEARTBEAT_TARGET` | No | Where to deliver (e.g., `telegram:123456789`) |

\* At least one channel must be configured

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/status` | Show current session info |
| `/heartbeat` | Manually trigger a heartbeat check-in |

## Skills

LettaBot supports skills that extend the agent's capabilities.

### View Skills

```bash
lettabot skills status
```

Shows enabled skills and skills available to import:

```
Enabled (3):
  ✓ gog
  ✓ google
  ✓ scheduling

Available to import (20):
  obsidian
  weather
  ...
```

### Feature-Gated Skills

Some skills are automatically enabled based on your configuration:

| Feature | Config | Skills Enabled |
|---------|--------|----------------|
| Scheduling | `CRON_ENABLED=true` | `scheduling` |
| Gmail | `GMAIL_ACCOUNT=...` | `gog`, `google` |

### Install from skills.sh

LettaBot is compatible with [skills.sh](https://skills.sh):

```bash
# Interactive search
npm run skills:find

# Install skill packs
npm run skills:add supabase/agent-skills
npm run skills:add anthropics/skills
```

## Heartbeat & Scheduling

### Heartbeat

LettaBot can periodically check in with you:

```bash
HEARTBEAT_INTERVAL_MIN=30
```

**Silent Mode**: During heartbeats, the agent's text output is NOT automatically sent to you. If the agent wants to contact you, it uses the `lettabot-message` CLI:

```bash
lettabot-message send --text "Hey, just checking in!"
```

This prevents spam - the agent only messages you when there's something worth saying.

### Scheduling

When `CRON_ENABLED=true`, the agent can create scheduled tasks:

**One-off reminders:**
```bash
lettabot-schedule create \
  --name "Standup" \
  --at "2026-01-28T20:15:00Z" \
  --message "Time for standup!"
```

**Recurring schedules:**
```bash
lettabot-schedule create \
  --name "Morning Briefing" \
  --schedule "0 8 * * *" \
  --message "Good morning! What's on today's agenda?"
```

## Security

### Network Architecture

**LettaBot uses outbound connections only** - no public URL or gateway required:

| Channel | Connection Type | Exposed Ports |
|---------|-----------------|---------------|
| Telegram | Long-polling (outbound HTTP) | None |
| Slack | Socket Mode (outbound WebSocket) | None |
| WhatsApp | Outbound WebSocket via Baileys | None |
| Signal | Local daemon on 127.0.0.1 | None |

### Tool Execution

By default, the agent is restricted to **read-only** operations:
- `Read`, `Glob`, `Grep` - File exploration
- `web_search` - Internet queries
- `conversation_search` - Search past messages

### Access Control

LettaBot supports pairing-based access control. When `TELEGRAM_DM_POLICY=pairing`:
1. Unauthorized users get a pairing code
2. You approve codes via `lettabot pairing approve telegram <CODE>`
3. Approved users can then chat with the bot

## Development

```bash
# Run in development mode (auto-reload)
npm run dev

# Build for production
npm run build

# Start production server
lettabot server
```

### Local Letta Server

To use a local Letta server instead of Letta Cloud:

```bash
LETTA_BASE_URL=http://localhost:8283 lettabot server
```

## Troubleshooting

### WhatsApp

**Session errors / "Bad MAC" messages**
These are normal Signal Protocol renegotiation messages. They're noisy but harmless.

**Messages going to wrong chat**
Clear the session and re-link:
```bash
rm -rf ./data/whatsapp-session
lettabot server  # Scan QR again
```

### Signal

**Port 8090 already in use**
```bash
SIGNAL_HTTP_PORT=8091
```

### General

**Agent not responding**
Delete the agent store to create a fresh agent:
```bash
rm lettabot-agent.json
lettabot server
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Slack Setup](docs/slack-setup.md)
- [WhatsApp Setup](docs/whatsapp-setup.md)
- [Signal Setup](docs/signal-setup.md)

## License

Apache-2.0
