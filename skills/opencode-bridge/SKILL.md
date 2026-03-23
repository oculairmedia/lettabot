---
name: opencode-bridge
description: OpenCode instance bridge for delegating coding work and communicating with development sessions.
---

# OpenCode Bridge

OpenCode instance bridge — send messages and tasks to running OpenCode coding sessions. Provides integration with active development environments for delegating coding work and coordinating development tasks.

## When to Use

- Delegating coding tasks to OpenCode instances
- Sending messages to active development sessions
- Coordinating work between multiple OpenCode instances
- Requesting code generation or refactoring from OpenCode
- Checking status of ongoing coding tasks
- Integrating OpenCode workflows into agent pipelines
- Automating development workflows

## Tools

OpenCode bridge tools are dynamically registered based on the connected OpenCode instances. The primary operations include:

### send_message
Send a message to an OpenCode instance.

**Parameters:**
- `target` (required) — Target OpenCode instance (project name or directory path)
- `message` (required) — Message content to send
- `task_type` (optional) — Type of task (code, refactor, test, debug, etc.)
- `context` (optional) — Additional context for the task

**Example:**
```json
{
  "target": "my-project",
  "message": "Create a new API endpoint for user authentication",
  "task_type": "code",
  "context": {"framework": "FastAPI", "auth_type": "JWT"}
}
```

### get_status
Get the status of an OpenCode instance.

**Parameters:**
- `target` (required) — Target OpenCode instance
- `include_tasks` (optional) — Include active tasks in response

**Example:**
```json
{
  "target": "my-project",
  "include_tasks": true
}
```

### list_instances
List all available OpenCode instances.

**Parameters:**
- `filter` (optional) — Filter instances by name or status
- `limit` (optional) — Maximum number of instances to return

**Example:**
```json
{
  "filter": "active",
  "limit": 10
}
```

### execute_task
Execute a specific task in an OpenCode instance.

**Parameters:**
- `target` (required) — Target OpenCode instance
- `task` (required) — Task description or command
- `priority` (optional) — Task priority (low, medium, high)
- `timeout` (optional) — Task timeout in seconds

**Example:**
```json
{
  "target": "my-project",
  "task": "Run tests and generate coverage report",
  "priority": "high",
  "timeout": 300
}
```

### cancel_task
Cancel an active task in an OpenCode instance.

**Parameters:**
- `target` (required) — Target OpenCode instance
- `task_id` (required) — ID of the task to cancel

**Example:**
```json
{
  "target": "my-project",
  "task_id": "task-123"
}
```

### get_output
Retrieve output from a completed task.

**Parameters:**
- `target` (required) — Target OpenCode instance
- `task_id` (required) — ID of the task
- `format` (optional) — Output format (text, json, markdown)

**Example:**
```json
{
  "target": "my-project",
  "task_id": "task-123",
  "format": "markdown"
}
```

## When NOT to Use

- For direct code execution in the current environment — use local execution instead
- When OpenCode instances are not running or available
- For tasks that require immediate synchronous execution — OpenCode is asynchronous
- When you need to modify files in the current agent's context — use local file operations
- For simple queries that don't require a full development environment
- When security policies prohibit delegating to external instances
