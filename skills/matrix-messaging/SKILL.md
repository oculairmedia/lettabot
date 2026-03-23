---
name: matrix-messaging
description: Full documentation for the matrix_messaging tool. Load when you need to use Matrix operations beyond basic talk_to_agent.
---

# Matrix Messaging Tool

Complete reference for the `matrix_messaging` tool operations.

## Quick Start — Talking to Agents

The most common operation. Use `talk_to_agent` with the agent's name:

```json
{
  "operation": "talk_to_agent",
  "agent": "Meridian",
  "message": "Hello!",
  "caller_directory": "/opt/stacks/my-project"
}
```

- **caller_directory** is REQUIRED — identifies you to the agent
- Agent names support fuzzy matching: "meridian", "MERIDIAN", "Merid" all work
- Also accepts `agent_id` if you have the UUID

### Common Agents

| Agent | Model | Role |
|-------|-------|------|
| Meridian | opus-4-6 | Companion agent |
| BMO | claude-sonnet-4 | Personal assistant |
| GraphitiExplorer | — | Knowledge graph agent |

## All Operations

### Letta Agent Operations (Primary)

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `talk_to_agent` | Send message to agent by name or ID | `agent`, `message`, `caller_directory` |
| `letta_chat` | Send to agent's room (supports conversation threading) | `agent_id` or `agent_name`, `message`, optional `conversation_id` |
| `letta_list` | List all agents with rooms | — |
| `letta_lookup` | Get agent details | `agent_id` or `agent_name` |
| `letta_conversations` | List/resume conversation threads for an agent | `agent_id` |

### Multi-Agent Operations

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `parallel_dispatch` | Send different messages to multiple agents simultaneously | `targets` (array of `{agent, message}`) |
| `broadcast` | Send the same message to multiple agents | `message`, `agent_names` (array) |

### OpenCode Messaging

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `opencode_list` | List active OpenCode instances | — |
| `talk_to_opencode` | Send to OpenCode instance | `target`, `message`, `caller_directory` |

### Room Operations

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `send` | Send message to room | `room_id`, `message` |
| `read` | Read room messages | `room_id` |
| `react` | Add reaction | `room_id`, `event_id`, `emoji` |
| `edit` | Edit message | `room_id`, `event_id`, `new_content` |
| `typing` | Show typing indicator | `room_id`, `typing` |
| `room_list` | List joined rooms | `scope` (optional: "joined" or "server") |
| `room_info` | Get room details | `room_id` |
| `room_join` | Join a room | `room_id_or_alias` |
| `room_leave` | Leave a room | `room_id` |
| `room_create` | Create a room | `name` |
| `room_invite` | Invite user to room | `room_id`, `user_mxid` |
| `room_search` | Search rooms | `query` |
| `room_find` | Find room by name | `query` |
| `room_members` | List room members | `room_id` |

### Identity Operations

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `identity_list` | List all identities | — |
| `identity_get` | Get identity details | `identity_id` |
| `identity_create` | Create new identity | `id`, `localpart`, `display_name`, `type` |
| `identity_derive` | Derive identity from session | `session_id` |

### OpenCode Bridge Operations

| Operation | Description | Required Params |
|-----------|-------------|-----------------|
| `opencode_connect` | Register OpenCode instance | `directory` |
| `opencode_send` | Send raw message | `directory`, `message` |
| `opencode_notify` | Send notification | `directory`, `message` |
| `opencode_status` | Check connection status | `directory` |

## How It Works

Messages flow through Matrix rooms (not DMs):
1. You call `talk_to_agent` with agent name + message
2. Message appears in the agent's Matrix room
3. Matrix bridge forwards to Letta
4. Agent responds in the same room
5. Response visible in Matrix clients (Element, etc.)

## Parameter Reference

### Caller Context
- `caller_directory` — Working directory path (REQUIRED for agent routing)
- `caller_name` — Display name override
- `caller_source` — "opencode" or "claude-code"

### Message Parameters
- `message` — Text to send
- `to_mxid` — Target user Matrix ID (format: @user:domain)
- `msgtype` — m.text (default), m.notice, m.emote
- `event_id` — Event ID for reactions/edits
- `reply_to_event_id` — Event ID to reply to (threaded reply)
- `emoji` — Reaction emoji
- `new_content` — New content when editing

### Room Parameters
- `room_id` — Room ID (format: !roomId:domain)
- `room_id_or_alias` — Room ID or alias (#name:domain)
- `name` — Room name for creation
- `topic` — Room topic/description
- `is_public` — Public or private room
- `invite` — List of MXIDs to invite
- `limit` — Max results (default: 50 for read, 10 for search)
- `scope` — "joined" (identity rooms) or "server" (all admin rooms)

### Identity Parameters
- `identity_id` — Identity ID
- `sender_identity_id` — Override sender identity for talk_to_agent
- `localpart` — Username without @domain
- `display_name` — Human-readable name
- `type` — "custom", "letta", or "opencode"

### Agent Parameters
- `agent` — Agent name OR ID (simplest way)
- `agent_id` — Agent UUID
- `agent_name` — Agent name with fuzzy matching
- `target` — OpenCode instance (project name or path)
- `conversation_id` — Resume a conversation thread (for `letta_chat`)
- `targets` — Array of `{agent, message}` objects (for `parallel_dispatch`)
- `agent_names` — Array of agent names (for `broadcast`)
