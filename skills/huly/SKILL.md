---
name: huly
description: Load when user asks about project management, issues, tasks, workflows, GitHub integration, or project planning. Use for task tracking, issue management, and team coordination.
---

# Huly

Project management system via Huly for managing issues, projects, workflows, templates, queries, and GitHub integration.

## When to Use
- User wants to create or manage issues
- User asks about project status or progress
- User needs to set up workflows or templates
- User wants to query project data
- User needs GitHub integration or sync
- User asks about task assignments or workflows
- User wants to validate project data
- User needs account or team management

## Tools

### huly_issue_ops
Create, update, delete, or list issues.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `title` (required for create) — issue title
- `description` (optional) — issue description
- `project_id` (optional) — project ID to filter by
- `status` (optional) — issue status (open, in-progress, closed, etc.)
- `assignee` (optional) — user ID to assign to
- `priority` (optional) — priority level (low, medium, high, critical)
- `issue_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "huly_issue_ops",
  "action": "create",
  "title": "Fix login bug",
  "description": "Users unable to login with SSO",
  "project_id": "proj_123",
  "priority": "high",
  "assignee": "user_456"
}
```

### huly_workflow
Manage project workflows and workflow states.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `workflow_name` (required) — name of the workflow
- `states` (optional) — comma-separated list of workflow states
- `project_id` (optional) — project ID to associate with
- `workflow_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "huly_workflow",
  "action": "create",
  "workflow_name": "Development",
  "states": "backlog,in-progress,review,done",
  "project_id": "proj_123"
}
```

### huly_template_ops
Create and manage issue templates.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `template_name` (required) — name of the template
- `template_content` (required) — template content/structure
- `project_id` (optional) — project ID to associate with
- `template_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "huly_template_ops",
  "action": "create",
  "template_name": "Bug Report",
  "template_content": "Description:\nSteps to reproduce:\nExpected behavior:\nActual behavior:",
  "project_id": "proj_123"
}
```

### huly_query
Execute custom queries on project data.

**Parameters:**
- `query` (required) — query string or query ID
- `filters` (optional) — JSON object with filter conditions
- `limit` (optional) — maximum results to return

**Example:**
```json
{
  "operation": "huly_query",
  "query": "issues_by_status",
  "filters": {
    "status": "in-progress",
    "project_id": "proj_123"
  },
  "limit": 20
}
```

### huly_entity
Get or search for entities (issues, projects, users, etc.).

**Parameters:**
- `entity_type` (required) — type of entity (issue, project, user, etc.)
- `entity_id` (optional) — specific entity ID to retrieve
- `search_query` (optional) — search term to find entities
- `limit` (optional) — maximum results to return

**Example:**
```json
{
  "operation": "huly_entity",
  "entity_type": "issue",
  "search_query": "login bug",
  "limit": 10
}
```

### huly_account_ops
Manage accounts and team members.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `username` (required for create) — username for the account
- `email` (optional) — email address
- `role` (optional) — user role (member, lead, admin)
- `account_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "huly_account_ops",
  "action": "create",
  "username": "john_dev",
  "email": "john@example.com",
  "role": "member"
}
```

### huly_integration
Manage integrations with external services like GitHub.

**Parameters:**
- `action` (required) — action to perform (connect, disconnect, sync, list)
- `integration_type` (required) — type of integration (github, gitlab, etc.)
- `config` (optional) — integration configuration (API keys, repos, etc.)
- `integration_id` (optional) — ID for disconnect operations

**Example:**
```json
{
  "operation": "huly_integration",
  "action": "connect",
  "integration_type": "github",
  "config": {
    "api_token": "ghp_xxxxx",
    "repositories": ["owner/repo1", "owner/repo2"]
  }
}
```

### huly_validate
Validate project data and configuration.

**Parameters:**
- `entity_type` (required) — type of entity to validate (issue, project, workflow, etc.)
- `entity_id` (required) — ID of the entity to validate
- `strict_mode` (optional) — enable strict validation (true/false)

**Example:**
```json
{
  "operation": "huly_validate",
  "entity_type": "issue",
  "entity_id": "issue_789",
  "strict_mode": true
}
```

## When NOT to Use
- User is asking about kitchen/recipes (use kitchen-orchestrator skill instead)
- User needs financial tracking (use surefinance skill instead)
- User is asking about 3D modeling or VFX (use houdini skill instead)
- User needs knowledge graph or memory management (use graphiti skill instead)
