---
name: messaging-agents
description: Send messages to other agents on your server. Use when you need to communicate with, query, or delegate tasks to another agent.
---

# Messaging Agents

This skill enables you to send messages to other agents on the same Letta server.

## Preferred Transport: Matrix Messaging

**When the user asks you to send a message to another agent, you MUST use the `matrix_messaging` tool with the `talk_to_agent` operation as your messaging transport.** Do not use the CLI (`letta -p --from-agent ...`) for sending messages — use Matrix tooling instead.

### talk_to_agent (Single Agent)

```json
{
  "operation": "talk_to_agent",
  "agent": "AgentName",
  "message": "Your message here",
  "caller_directory": "/opt/stacks/your-project"
}
```

You can specify the target by name (fuzzy matched) or by full agent ID:

```json
{
  "operation": "talk_to_agent",
  "agent": "agent-597b5756-2915-4560-ba6b-91005f085166",
  "message": "Status update: all issues are done.",
  "caller_directory": "/opt/stacks/your-project"
}
```

### parallel_dispatch (Multiple Agents, Different Messages)

Send different messages to multiple agents simultaneously. All messages are dispatched in parallel via `Promise.all` — you get all responses back in one call.

```json
{
  "operation": "parallel_dispatch",
  "targets": [
    {"agent": "Huly - Matrix Synapse Deployment", "message": "What's the status of the bridge?"},
    {"agent": "Huly - LettaBot", "message": "Are there any open P1 issues?"},
    {"agent": "Meridian-Triage", "message": "Any alerts in the last hour?"}
  ],
  "caller_directory": "/opt/stacks/your-project"
}
```

**When to use:** Council deliberation, gathering status from multiple subsystems, asking different specialists different questions.

### broadcast (Multiple Agents, Same Message)

Send the same message to multiple agents at once.

```json
{
  "operation": "broadcast",
  "message": "All systems entering maintenance window at 2am UTC. Pause non-critical operations.",
  "agent_names": ["Meridian-Triage", "Huly - LettaBot", "Huly - Matrix Synapse Deployment"],
  "caller_directory": "/opt/stacks/your-project"
}
```

**When to use:** Announcements, triggering parallel reviews of the same artifact, collecting diverse opinions on the same question.

### Conversation Threading (Continue a Conversation)

Use `conversation_id` with `letta_chat` to maintain conversation threads:

```json
{
  "operation": "letta_chat",
  "agent_id": "agent-xxx",
  "message": "Follow up on the auth discussion",
  "conversation_id": "conversation-xyz789"
}
```

The response includes a `conversation_id` you can use for follow-ups.

List existing conversations with an agent:
```json
{
  "operation": "letta_conversations",
  "agent_id": "agent-xxx"
}
```

**Why Matrix over CLI:**
- Matrix is the native transport for inter-agent communication in this environment
- Messages are routed through Matrix rooms, providing audit trails and conversation history
- No subprocess overhead — direct tool call vs spawning a shell process
- Other agents can see and respond asynchronously via their Matrix integrations

## When to Use This Skill

- You need to ask another agent a question
- You want to query an agent that has specialized knowledge
- You need information that another agent has in their memory
- You want to coordinate with another agent on a task
- You need to dispatch work to multiple agents in parallel
- You want to broadcast an announcement to several agents
- The user explicitly asks you to "send a message to" or "report to" another agent

## What the Target Agent Can and Cannot Do

**The target agent CANNOT:**
- Access your local environment (read/write files in your codebase)
- Execute shell commands on your machine
- Use your tools (Bash, Read, Write, Edit, etc.)

**The target agent CAN:**
- Use their own tools (whatever they have configured)
- Access their own memory blocks
- Make API calls if they have web/API tools
- Search the web if they have web search tools
- Respond with information from their knowledge/memory

**Important:** This skill is for *communication* with other agents, not *delegation* of local work. The target agent runs in their own environment and cannot interact with your codebase.

**Need local access?** If you need the target agent to access your local environment (read/write files, run commands), use the Task tool instead to deploy them as a subagent:
```typescript
Task({
  agent_id: "agent-xxx",           // Deploy this existing agent
  subagent_type: "explore",        // "explore" = read-only, "general-purpose" = read-write
  prompt: "Look at the code in src/ and tell me about the architecture"
})
```
This gives the agent access to your codebase while running as a subagent.

## Finding an Agent to Message

If you don't have a specific agent ID, use these approaches:

### By Name (via matrix_messaging)
```json
{
  "operation": "talk_to_agent",
  "agent": "Meridian",
  "message": "Hello, do you have a moment?"
}
```
The `agent` field supports fuzzy name matching — you don't need the exact ID.

### By Role (via agent registry)
```json
{
  "operation": "find_agents_by_role",
  "role": "devops"
}
```

### By Listing Available Agents
```json
{
  "operation": "letta_list"
}
```

### By Task Recommendation
Use the `agent-registry` skill's `recommend_team` tool to find the best agents for a task.

## Understanding the Response

- The target agent may use tools, think, and reason — but you typically only see their final response
- Matrix-routed messages appear in the agent's Matrix room for full audit trail
- `parallel_dispatch` returns an array of responses, one per target (includes errors per-agent)
- `broadcast` returns confirmation of delivery to all targets
- To see the full conversation transcript (including tool calls), use the `searching-messages` skill

## Related Skills

- **agent-registry**: Find agents by role, get team recommendations, manage named teams
- **agent-council**: Run structured multi-agent deliberation sessions
- **review-gate**: Route work through a reviewer agent before accepting
- **matrix-messaging**: Full documentation for all matrix_messaging operations
- **finding-agents**: Find agents by name, tags, or fuzzy search
- **searching-messages**: Search past messages across agents, or view full conversation transcripts
