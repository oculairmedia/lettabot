---
name: lettatoolsselector
description: Intelligent tool routing and selection for discovering and choosing optimal tools from the full catalog.
---

# Letta Tool Selector

Letta tool selector — intelligent tool routing and selection. Helps agents discover and choose the right tools for a given task from the full tool catalog. Provides smart recommendations based on task requirements and tool capabilities.

## When to Use

- Discovering available tools for a specific task
- Finding the best tool for a given problem
- Routing tasks to appropriate tools automatically
- Analyzing tool capabilities and compatibility
- Recommending tool combinations for complex tasks
- Optimizing tool selection for performance
- Learning about tool parameters and usage
- Matching user requests to available tools

## Tools

### discover_tools
Discover available tools based on task description or keywords.

**Parameters:**
- `query` (required) — Task description or keywords to search for tools
- `limit` (optional) — Maximum number of tools to return (default: 10)
- `category` (optional) — Filter by tool category
- `tags` (optional) — Filter by tags (comma-separated)

**Example:**
```json
{
  "query": "search documents and extract information",
  "limit": 5,
  "category": "search",
  "tags": "rag,documents"
}
```

### get_tool_info
Get detailed information about a specific tool.

**Parameters:**
- `tool_name` (required) — Name of the tool
- `include_examples` (optional) — Include usage examples (default: true)
- `include_parameters` (optional) — Include parameter details (default: true)

**Example:**
```json
{
  "tool_name": "search_documents",
  "include_examples": true,
  "include_parameters": true
}
```

### recommend_tools
Get tool recommendations for a specific task.

**Parameters:**
- `task_description` (required) — Description of the task to accomplish
- `constraints` (optional) — Constraints or requirements (speed, accuracy, cost)
- `limit` (optional) — Maximum number of recommendations (default: 5)
- `prefer_combinations` (optional) — Prefer tool combinations over single tools

**Example:**
```json
{
  "task_description": "Find and analyze academic papers on machine learning",
  "constraints": {"speed": "fast", "accuracy": "high"},
  "limit": 3,
  "prefer_combinations": true
}
```

### route_task
Route a task to the most appropriate tool or tool combination.

**Parameters:**
- `task` (required) — Task description
- `input_data` (optional) — Input data for the task
- `priority` (optional) — Task priority (low, medium, high)
- `auto_execute` (optional) — Automatically execute the recommended tool

**Example:**
```json
{
  "task": "Search for Python async/await best practices",
  "input_data": {"query": "python async await patterns"},
  "priority": "medium",
  "auto_execute": false
}
```

### analyze_tool_compatibility
Analyze compatibility between tools for chaining or combination.

**Parameters:**
- `tools` (required) — Array of tool names to analyze
- `task_context` (optional) — Context of the task they'll be used for

**Example:**
```json
{
  "tools": ["search_documents", "extract", "analyze_trace"],
  "task_context": "Extract and analyze error patterns from logs"
}
```

### list_tool_categories
List all available tool categories.

**Parameters:**
- `include_count` (optional) — Include count of tools per category (default: true)

**Example:**
```json
{
  "include_count": true
}
```

### search_tools
Search for tools by name, description, or capability.

**Parameters:**
- `query` (required) — Search query
- `search_type` (optional) — Type of search (name, description, capability, all)
- `limit` (optional) — Maximum number of results (default: 10)

**Example:**
```json
{
  "query": "web search",
  "search_type": "capability",
  "limit": 5
}
```

### get_tool_parameters
Get detailed parameter information for a tool.

**Parameters:**
- `tool_name` (required) — Name of the tool
- `include_defaults` (optional) — Include default values (default: true)
- `include_validation` (optional) — Include validation rules (default: true)

**Example:**
```json
{
  "tool_name": "search_stackoverflow",
  "include_defaults": true,
  "include_validation": true
}
```

### compare_tools
Compare multiple tools for a specific task.

**Parameters:**
- `tools` (required) — Array of tool names to compare
- `criteria` (optional) — Comparison criteria (speed, accuracy, cost, ease_of_use)
- `task_context` (optional) — Context of the task

**Example:**
```json
{
  "tools": ["search_documents", "search_stackoverflow", "search"],
  "criteria": ["speed", "accuracy", "ease_of_use"],
  "task_context": "Finding technical solutions"
}
```

### get_tool_examples
Get usage examples for a tool.

**Parameters:**
- `tool_name` (required) — Name of the tool
- `limit` (optional) — Maximum number of examples (default: 5)
- `complexity` (optional) — Filter by complexity (basic, intermediate, advanced)

**Example:**
```json
{
  "tool_name": "ingest_document",
  "limit": 3,
  "complexity": "intermediate"
}
```

## When NOT to Use

- For executing tools directly — use the tools themselves instead
- When you already know which tool to use
- For tasks that don't require tool selection or discovery
- When tool recommendations are not needed
- For real-time tool execution — this is for selection and routing only
- When you need to modify tool behavior or parameters directly
