---
name: agent-council
description: Run structured multi-agent deliberation sessions. Use when a decision benefits from multiple perspectives before committing.
---

# Agent Council

Run a structured deliberation where multiple agents weigh in on a decision, proposal, or question. Collect diverse perspectives, then synthesize a recommendation.

## When to Use

- Architecture decisions that affect multiple subsystems
- Security-sensitive changes that need review from different angles
- Deployment decisions where risk assessment matters
- Design choices where you want multiple expert opinions
- Any decision where "ask one agent" isn't enough

## How It Works

1. **Assemble** — Pick agents by role, team, or manual selection
2. **Dispatch** — Send the question to all agents in parallel
3. **Collect** — Gather all responses
4. **Synthesize** — You (the orchestrator) summarize and decide

## Step 1: Assemble the Council

### Option A: Use an existing team
```json
{
  "action": "get",
  "team_id": "infra-review-team",
  "enrich": true
}
```

### Option B: Get recommendations for the task
```json
{
  "task": "evaluate whether to migrate auth from JWT to session tokens",
  "roles": "backend,security,reviewer",
  "limit": 2
}
```

### Option C: Pick agents by role
```json
{ "role": "security", "status": "active" }
{ "role": "backend", "status": "active" }
{ "role": "reviewer", "status": "active" }
```

## Step 2: Dispatch the Question

### Same question to all (broadcast)
```json
{
  "operation": "broadcast",
  "message": "COUNCIL REQUEST: Should we migrate from JWT to session-based auth? Consider: security implications, performance impact, migration complexity, and rollback strategy. Respond with your assessment and recommendation.",
  "agent_names": ["Huly - LettaBot", "Huly - Matrix Synapse Deployment", "Meridian-Triage"]
}
```

### Different questions per role (parallel_dispatch)
```json
{
  "operation": "parallel_dispatch",
  "targets": [
    {
      "agent": "Huly - LettaBot",
      "message": "COUNCIL: Evaluate the security implications of migrating from JWT to session-based auth."
    },
    {
      "agent": "Huly - Matrix Synapse Deployment",
      "message": "COUNCIL: What are the infrastructure requirements for session-based auth? Redis/memcached needs?"
    },
    {
      "agent": "Meridian-Triage",
      "message": "COUNCIL: From an operational perspective, what monitoring changes would session-based auth require?"
    }
  ]
}
```

## Step 3: Collect and Synthesize

After receiving all responses, summarize:

```
## Council Summary: JWT to Session Auth Migration

### Perspectives Received
- **Security (LettaBot)**: Recommends migration — session revocation is immediate vs JWT expiry window
- **Infrastructure (Synapse Deployment)**: Feasible — need Redis cluster, estimates 2h setup
- **Operations (Triage)**: Caution — need new monitoring for session store health

### Consensus
Proceed with migration. Add Redis monitoring before cutover.

### Dissent
None — all agents support migration with noted prerequisites.

### Recommendation
Approve with conditions: Redis cluster + monitoring must be deployed first.
```

## Patterns

### Quick Council (2-3 agents, same question)
Use `broadcast`. Best for "should we do X?" decisions.

### Expert Panel (3-5 agents, role-specific questions)
Use `parallel_dispatch`. Best for complex decisions needing domain-specific input.

### Threaded Council (multi-round)
Use `letta_chat` with `conversation_id` to follow up with individual agents:
```json
{
  "operation": "letta_chat",
  "agent_name": "Huly - LettaBot",
  "message": "Follow up: you mentioned session revocation — what about refresh token rotation as an alternative?",
  "conversation_id": "conv-from-earlier"
}
```

### Standing Committee
Create a persistent team for recurring reviews:
```json
{
  "action": "create",
  "name": "security-review-committee",
  "description": "Standing committee for security-sensitive changes",
  "members": "[{\"agent_id\":\"agent-xxx\",\"role\":\"security\"},{\"agent_id\":\"agent-yyy\",\"role\":\"reviewer\"},{\"agent_id\":\"agent-zzz\",\"role\":\"backend\"}]"
}
```

## Tips

- **Prefix council messages** with `COUNCIL REQUEST:` or `COUNCIL:` so agents know the context
- **Be specific** about what you want each agent to evaluate
- **Set a minimum** of 2 agents — a council of 1 is just a question
- **Don't over-council** — simple changes don't need deliberation
- The orchestrator (you) always makes the final decision — the council advises

## Prerequisites

- `messaging-agents` skill (for `parallel_dispatch` and `broadcast`)
- `agent-registry` skill (for `find_agents_by_role` and `manage_teams`)

## Related Skills

- **messaging-agents**: The transport layer for council communication
- **agent-registry**: Find and organize agents into teams
- **review-gate**: Simpler pattern when you just need one reviewer's approval
