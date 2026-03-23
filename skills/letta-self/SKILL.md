---
name: letta-self
description: Letta platform self-management for agents, tools, memory, sources, files, MCP servers, and jobs.
---

# Letta Self-Management

Letta platform self-management — manage agents, tools, memory, sources, files, MCP servers, and jobs. Provides comprehensive administration and operational control over the Letta platform.

## When to Use

- Creating, updating, or deleting Letta agents
- Managing tools and attaching them to agents
- Configuring agent memory (core, archival, blocks)
- Managing document sources and file uploads
- Registering and managing MCP servers
- Monitoring and managing background jobs
- Exporting and importing agent configurations

## Tools

### letta_tool_manager
Manage tools in the Letta platform — create, update, delete, attach to agents, and generate tools from descriptions.

**Parameters:**
- `operation` (required) — Operation to perform (list, get, create, update, delete, upsert, attach, detach, bulk_attach, generate_from_prompt, generate_schema, run_from_source, add_base_tools)
- `tool_id` (optional) — Tool ID for get, delete, update, attach, detach operations
- `name` (optional) — Tool name for create/upsert operations
- `source_code` (optional) — Python source code for create/upsert operations
- `description` (optional) — Tool description for create/generate_from_prompt operations
- `agent_id` (optional) — Agent ID for attach, detach, add_base_tools operations
- `agent_ids` (optional) — Array of agent IDs for bulk_attach operation
- `tags` (optional) — Tags array for filtering or categorizing tools

**Example:**
```json
{
  "operation": "create",
  "name": "weather_tool",
  "source_code": "def get_weather(location: str) -> str:\n    return f'Weather for {location}'",
  "description": "Get weather information for a location"
}
```

### letta_agent_advanced
Advanced agent management — create, update, delete, send messages, manage conversations, and export/import agents.

**Parameters:**
- `operation` (required) — Operation to perform (list, create, get, update, delete, send_message, send_conversation_message, export, import, clone, get_config, context, reset_messages, summarize, stream, async_message, cancel_message, list_conversations, get_conversation, cancel_conversation, compact_conversation, count, search_messages, get_message, list_tools)
- `agent_id` (optional) — Agent ID for most operations
- `name` (optional) — Agent name for create/update operations
- `system` (optional) — System prompt for create/update operations
- `llm_config` (optional) — LLM configuration object
- `tool_ids` (optional) — Array of tool IDs to attach
- `messages` (optional) — Messages array for send_message/stream operations
- `conversation_id` (optional) — Conversation ID for conversation operations
- `export_data` (optional) — Full agent export data for import operation

**Example:**
```json
{
  "operation": "create",
  "name": "research-agent",
  "system": "You are a research assistant.",
  "llm_config": {"model": "gpt-4", "temperature": 0.7},
  "tool_ids": ["tool-1", "tool-2"]
}
```

### letta_mcp_ops
MCP server management — add, update, delete, test, connect, register tools, and attach MCP servers to agents.

**Parameters:**
- `operation` (required) — Operation to perform (add, update, delete, test, connect, resync, list_servers, list_tools, register_tool, execute, attach_mcp_server)
- `server_name` (optional) — MCP server display name for add operation
- `server_config` (optional) — MCP server configuration object
- `mcp_server_id` (optional) — MCP server ID for update, delete, test, connect, resync, list_tools, register_tool operations
- `tool_name` (optional) — Tool name to register for register_tool operation
- `agent_id` (optional) — Agent ID for attach_mcp_server operation
- `tool_id` (optional) — Tool ID for execute operation
- `tool_args` (optional) — Arguments to pass when running tool

**Example:**
```json
{
  "operation": "add",
  "server_name": "my-mcp-server",
  "server_config": {
    "type": "stdio",
    "command": "python",
    "args": ["-m", "my_mcp_server"]
  }
}
```

### letta_file_folder_ops
File and folder management — manage file sessions, open/close files, and attach folders to agents.

**Parameters:**
- `operation` (required) — Operation to perform (list_files, open_file, close_file, close_all_files, list_folders, attach_folder, detach_folder, list_agents_in_folder)
- `agent_id` (optional) — Agent ID for file sessions and folder operations
- `file_id` (optional) — File ID for open_file, close_file operations
- `folder_id` (optional) — Folder ID for attach_folder, detach_folder, list_agents_in_folder operations
- `limit` (optional) — Maximum number of results to return
- `offset` (optional) — Number of results to skip for pagination

**Example:**
```json
{
  "operation": "open_file",
  "agent_id": "agent-123",
  "file_id": "file-456"
}
```

### letta_source_manager
Document source management — create, update, delete, attach sources to agents, and upload files.

**Parameters:**
- `operation` (required) — Operation to perform (list, get, create, update, delete, attach, detach, list_attached, upload, delete_files, list_files)
- `source_id` (optional) — Source ID for get, delete, update, attach, detach, upload, list_files operations
- `name` (optional) — Source name for create operation
- `description` (optional) — Source description for create/update operations
- `agent_id` (optional) — Agent ID for attach, detach, list_attached operations
- `file_name` (optional) — File name for upload operation
- `file_data` (optional) — Base64-encoded file data for upload operation
- `content_type` (optional) — MIME content type of the file

**Example:**
```json
{
  "operation": "create",
  "name": "research-documents",
  "description": "Collection of research papers"
}
```

### letta_job_monitor
Job monitoring — list all jobs, get specific job details, cancel jobs, and list active jobs.

**Parameters:**
- `operation` (required) — Operation to perform (list, get, cancel, list_active)
- `job_id` (optional) — Job ID for get, cancel operations
- `limit` (optional) — Maximum number of jobs to return

**Example:**
```json
{
  "operation": "list",
  "limit": 20
}
```

### letta_memory_unified
Unified memory management — manage core memory, archival memory, memory blocks, and archives.

**Parameters:**
- `operation` (required) — Operation to perform (get_core_memory, update_core_memory, get_block_by_label, list_blocks, create_block, get_block, update_block, attach_block, detach_block, list_agents_using_block, search_archival, list_passages, create_passage, update_passage, delete_passage, list_archives, get_archive, create_archive, update_archive, delete_archive, attach_archive, detach_archive, list_agents_using_archive, search_memory)
- `agent_id` (optional) — Agent ID for core memory and archival operations
- `block_label` (optional) — Memory block label (e.g., 'human', 'persona')
- `block_id` (optional) — Memory block ID for get_block, update_block, attach_block, detach_block operations
- `value` (optional) — Value/content for creating or updating blocks
- `text` (optional) — Text content for creating archival passages
- `query` (optional) — Search query for archival or memory search
- `archive_id` (optional) — Archive ID for get_archive, update_archive, delete_archive operations
- `label` (optional) — Label for creating blocks or archives
- `passage_id` (optional) — Passage ID for update_passage, delete_passage operations

**Example:**
```json
{
  "operation": "update_core_memory",
  "agent_id": "agent-123",
  "block_label": "human",
  "value": "User prefers concise responses"
}
```

## When NOT to Use

- For simple agent queries — use direct message sending instead
- When you don't have proper authentication/authorization for platform operations
- For real-time monitoring of agent conversations — use conversation APIs instead
- When managing external systems — Letta self-management is platform-specific
- For user-facing operations that should go through the API gateway
