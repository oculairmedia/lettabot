---
name: agent-registry
description: Agent discovery and team management — search by capability/role, get team recommendations, manage named agent teams.
---

# Agent Registry

Discover Letta agents by capability, role, or name. Build and manage named agent teams. Get recommendations for task-specific agent groups.

## When to Use

- Finding agents with specific capabilities or roles
- Getting team recommendations for a task
- Creating/managing named agent teams
- Filtering agents by role (devops, companion, triage, etc.)
- Building agent councils for deliberation

## MCP Tools (via agent-registry MCP server)

### find_agents

Semantic search for agents by description/capability.

```json
{
  "query": "infrastructure deployment automation",
  "limit": 10,
  "min_score": 0.3
}
```

### find_agents_by_role

Filter agents by their assigned role. Direct lookup, no embedding needed.

```json
{
  "role": "devops",
  "status": "active",
  "limit": 50
}
```

**Available roles:** `companion`, `triage`, `devops`, `project-management`, `data`, `research`, `reviewer`, `backend`, `frontend`, `testing`

### recommend_team

Given a task description, get agents grouped by role to form a team.

```json
{
  "task": "implement OAuth login with security review",
  "roles": "backend,security,reviewer",
  "limit": 5,
  "min_score": 0.3
}
```

Returns agents sorted by relevance within each role group. The `roles` parameter is optional — omit it to get recommendations across all roles.

### manage_teams

Create, list, get, update, or delete named agent teams.

**Create a team:**
```json
{
  "action": "create",
  "name": "infra-review-team",
  "description": "Team for infrastructure review and maintenance",
  "members": "[{\"agent_id\":\"agent-xxx\",\"role\":\"devops\"},{\"agent_id\":\"agent-yyy\",\"role\":\"reviewer\"}]"
}
```

**List all teams:**
```json
{
  "action": "list"
}
```

**Get team details (with full agent info):**
```json
{
  "action": "get",
  "team_id": "abc12345",
  "enrich": true
}
```

**Update a team:**
```json
{
  "action": "update",
  "team_id": "abc12345",
  "members": "[{\"agent_id\":\"agent-xxx\",\"role\":\"backend\"},{\"agent_id\":\"agent-zzz\",\"role\":\"security\"}]"
}
```

**Delete a team:**
```json
{
  "action": "delete",
  "team_id": "abc12345"
}
```

## REST API (direct HTTP)

The registry also exposes REST endpoints at `http://192.168.50.90:8021`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/agents/register` | POST | Register a new agent (with optional `role` field) |
| `/api/v1/agents/search` | GET | Semantic search by query |
| `/api/v1/agents/by-role` | GET | Filter by role and status |
| `/api/v1/agents/recommend` | POST | Team composition recommendations |
| `/api/v1/agents/{id}` | GET | Get agent details |
| `/api/v1/agents/{id}/status` | PUT | Update agent status |
| `/api/v1/agents/{id}` | DELETE | Deregister an agent |
| `/api/v1/teams` | POST | Create a team |
| `/api/v1/teams` | GET | List all teams |
| `/api/v1/teams/{id}` | GET | Get team (add `?enrich=true` for agent details) |
| `/api/v1/teams/{id}` | PUT | Update a team |
| `/api/v1/teams/{id}` | DELETE | Delete a team |
| `/health` | GET | Service health check |

## Role System

Agents are automatically assigned roles during sync based on their name, tools, and description. Roles can also be set manually via the `/register` endpoint.

The sync service runs every 5 minutes, pulling agents from Letta and updating the Weaviate vector database with role inference.

## When NOT to Use

- For direct agent communication (use `messaging-agents` skill instead)
- For managing agent configuration (use Letta admin API)
- For creating new agents (use Letta API)

## Related Skills

- **messaging-agents**: Send messages using `talk_to_agent`, `parallel_dispatch`, `broadcast`
- **agent-council**: Run structured multi-agent deliberation using registry teams
- **review-gate**: Route work through reviewer agents
