---
name: switchboard
description: Agent message scheduling (Letta Switchboard) — create/manage scheduled messages to Letta agents, view execution results.
---

# Switchboard

Schedule and manage automated messages to Letta agents. Create recurring or one-time scheduled tasks, monitor execution results, and review past outcomes.

## When to Use

- Automating periodic agent check-ins
- Scheduling recurring tasks or reminders
- Reviewing past execution outcomes
- Managing agent communication workflows
- Setting up time-based agent interactions

## Tools

### switchboard_schedules

Create, list, and manage scheduled messages to Letta agents.

**Parameters:**
- `action` (required) — Operation to perform: "create", "list", "get", "update", "delete"
- `agent_id` (optional) — Target Letta agent ID
- `message` (optional) — Message content to send
- `schedule` (optional) — Cron expression or schedule definition
- `schedule_id` (optional) — ID of existing schedule to retrieve/update/delete

**Example:**
```json
{
  "action": "create",
  "agent_id": "agent-uuid-here",
  "message": "Daily status check",
  "schedule": "0 9 * * *"
}
```

### switchboard_results

View execution results and history of scheduled messages.

**Parameters:**
- `action` (required) — Operation to perform: "list", "get", "clear"
- `schedule_id` (optional) — Filter results by schedule ID
- `limit` (optional) — Maximum results to return
- `offset` (optional) — Pagination offset

**Example:**
```json
{
  "action": "list",
  "schedule_id": "schedule-uuid-here",
  "limit": 10
}
```

## When NOT to Use

- For immediate, non-scheduled agent communication (use direct messaging instead)
- For one-off messages that don't need scheduling
- When real-time response is required (scheduling has inherent delays)
- For complex conditional logic (use agent tools directly)
