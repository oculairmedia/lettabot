# LettaBot Documentation

LettaBot is a Telegram bot powered by [Letta](https://letta.com) that provides persistent memory and local tool execution.

## Guides

- [Getting Started](./getting-started.md) - Installation and basic setup
- [Gmail Pub/Sub](./gmail-pubsub.md) - Email notifications integration
- [Commands](./commands.md) - Bot commands reference

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Your Server / Machine                             │
│                                                                       │
│  ┌────────────────┐        ┌───────────────────────────────────────┐ │
│  │    Telegram    │        │            LettaBot Core               │ │
│  │    Bot API     │◀──────▶│         (TypeScript/Node)             │ │
│  │   (grammY)     │        │                                       │ │
│  └────────────────┘        │  ┌─────────────────────────────────┐  │ │
│                            │  │     Session Manager              │  │ │
│                            │  │  userId → agentId (persisted)   │  │ │
│                            │  └─────────────────────────────────┘  │ │
│                            │                                       │ │
│                            │  ┌─────────────────────────────────┐  │ │
│                            │  │     Letta Code SDK              │  │ │
│                            │  │  createSession/resumeSession    │  │ │
│                            │  └──────────────┬──────────────────┘  │ │
│                            └─────────────────┼─────────────────────┘ │
│                                              │ spawn subprocess      │
│                                              ▼                       │
│                            ┌─────────────────────────────────────┐   │
│                            │          Letta Code CLI              │   │
│                            │   (--input-format stream-json)       │   │
│                            │                                      │   │
│                            │  Local Tool Execution:               │   │
│                            │  • Read/Glob/Grep - file ops         │   │
│                            │  • Task - spawn subagents            │   │
│                            │  • web_search - internet queries     │   │
│                            └──────────────────┬───────────────────┘   │
└───────────────────────────────────────────────┼───────────────────────┘
                                                │ Letta API
                                                ▼
                              ┌──────────────────────────────────┐
                              │        Letta Server              │
                              │   (api.letta.com or self-hosted) │
                              │                                  │
                              │  • Agent Memory (persistent)     │
                              │  • LLM Inference                 │
                              │  • Conversation History          │
                              └──────────────────────────────────┘
```

## Key Features

- **Persistent Memory** - Your agent remembers conversations across days/weeks/months
- **Local Tool Execution** - Agent can search files, run commands on your machine
- **Multi-user Support** - Each Telegram user gets their own persistent agent
- **Streaming Responses** - Real-time message updates as the agent thinks
- **Gmail Integration** - Get email summaries delivered to Telegram
