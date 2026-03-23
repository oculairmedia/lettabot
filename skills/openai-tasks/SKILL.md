---
name: openai-tasks
description: OpenAI task management — monitor running tasks, send messages/control signals, read task files, view task history.
---

# OpenAI Tasks

Monitor and manage long-running OpenAI tasks. Send messages and control signals, read task files, check status, and review execution history.

## When to Use

- Monitoring long-running AI tasks
- Checking task status and progress
- Sending messages to running tasks
- Reading task output files
- Reviewing task execution history
- Sending control signals to tasks

## Tools

### read_task_file

Read files associated with a running task.

**Parameters:**
- `task_id` (required) — ID of the task
- `file_path` (required) — Path to file within task

**Example:**
```json
{
  "task_id": "task-123",
  "file_path": "output.txt"
}
```

### send_task_control

Send control signals to a running task (pause, resume, stop).

**Parameters:**
- `task_id` (required) — ID of the task
- `signal` (required) — Control signal: "pause", "resume", "stop"

**Example:**
```json
{
  "task_id": "task-123",
  "signal": "pause"
}
```

### send_task_message

Send a message to a running task.

**Parameters:**
- `task_id` (required) — ID of the task
- `message` (required) — Message content

**Example:**
```json
{
  "task_id": "task-123",
  "message": "Continue with next batch"
}
```

### get_task_status

Get current status of a task.

**Parameters:**
- `task_id` (required) — ID of the task

**Example:**
```json
{
  "task_id": "task-123"
}
```

### get_task_files

List files associated with a task.

**Parameters:**
- `task_id` (required) — ID of the task
- `pattern` (optional) — File pattern filter

**Example:**
```json
{
  "task_id": "task-123",
  "pattern": "*.log"
}
```

### get_task_history

Retrieve execution history for a task.

**Parameters:**
- `task_id` (required) — ID of the task
- `limit` (optional) — Maximum history entries to return
- `offset` (optional) — Pagination offset

**Example:**
```json
{
  "task_id": "task-123",
  "limit": 50
}
```

### health

Check health status of the OpenAI task service.

**Parameters:**
- None

**Example:**
```json
{}
```

## When NOT to Use

- For creating new tasks (use OpenAI API directly)
- For tasks that have already completed
- When you need real-time streaming (use WebSocket connections instead)
- For batch operations on multiple tasks (use task management API)
