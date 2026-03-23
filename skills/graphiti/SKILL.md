---
name: graphiti
description: Load when user asks about memory, knowledge graphs, long-term learning, fact storage, entity relationships, or context retrieval. Use for persistent memory management and knowledge graph operations.
---

# Graphiti

Knowledge graph memory system (Graphiti) for adding episodes, searching facts and nodes, exploring entity relationships, and managing memory edges.

## When to Use
- User wants to store information for long-term memory
- User asks to recall facts or previous context
- User wants to explore relationships between concepts
- User asks about entity information or connections
- User needs to search memory or knowledge base
- User wants to manage memory episodes
- User asks about what the agent knows about a topic
- User needs to update or delete memory entries

## Tools

### add_memory
Add a new memory episode or fact to the knowledge graph.

**Parameters:**
- `content` (required) — the memory content or fact to store
- `entity_names` (optional) — comma-separated list of entities mentioned
- `tags` (optional) — comma-separated tags for categorization
- `metadata` (optional) — JSON object with additional metadata

**Example:**
```json
{
  "operation": "add_memory",
  "content": "User prefers coffee over tea and drinks it every morning",
  "entity_names": "user,coffee,tea",
  "tags": "preferences,beverages",
  "metadata": {
    "importance": "high",
    "source": "conversation"
  }
}
```

### get_episodes
Retrieve memory episodes with optional filtering.

**Parameters:**
- `limit` (optional) — maximum number of episodes to return
- `offset` (optional) — number of episodes to skip for pagination
- `entity_filter` (optional) — filter by entity name
- `tag_filter` (optional) — filter by tag

**Example:**
```json
{
  "operation": "get_episodes",
  "limit": 20,
  "entity_filter": "user",
  "tag_filter": "preferences"
}
```

### delete_episode
Delete a memory episode.

**Parameters:**
- `episode_id` (required) — ID of the episode to delete

**Example:**
```json
{
  "operation": "delete_episode",
  "episode_id": "ep_123"
}
```

### search_memory_facts
Search for facts in memory by keyword or phrase.

**Parameters:**
- `query` (required) — search query or keyword
- `limit` (optional) — maximum number of results to return
- `entity_filter` (optional) — filter by entity name

**Example:**
```json
{
  "operation": "search_memory_facts",
  "query": "coffee preferences",
  "limit": 10,
  "entity_filter": "user"
}
```

### search_memory_nodes
Search for entities or nodes in the knowledge graph.

**Parameters:**
- `query` (required) — search query for entity names
- `limit` (optional) — maximum number of results to return
- `node_type` (optional) — filter by node type

**Example:**
```json
{
  "operation": "search_memory_nodes",
  "query": "coffee",
  "limit": 10,
  "node_type": "entity"
}
```

### search_recent_context
Search for recent memory entries and context.

**Parameters:**
- `days` (optional) — number of days to look back (default 7)
- `limit` (optional) — maximum number of results to return
- `entity_filter` (optional) — filter by entity name

**Example:**
```json
{
  "operation": "search_recent_context",
  "days": 7,
  "limit": 20,
  "entity_filter": "user"
}
```

### get_entity_neighbors
Get related entities connected to a specific entity.

**Parameters:**
- `entity_name` (required) — name of the entity to explore
- `depth` (optional) — relationship depth to explore (default 1)
- `limit` (optional) — maximum number of neighbors to return

**Example:**
```json
{
  "operation": "get_entity_neighbors",
  "entity_name": "coffee",
  "depth": 2,
  "limit": 15
}
```

### get_entity_edge
Get information about a relationship between two entities.

**Parameters:**
- `source_entity` (required) — name of the source entity
- `target_entity` (required) — name of the target entity

**Example:**
```json
{
  "operation": "get_entity_edge",
  "source_entity": "user",
  "target_entity": "coffee"
}
```

### delete_entity_edge
Delete a relationship between two entities.

**Parameters:**
- `source_entity` (required) — name of the source entity
- `target_entity` (required) — name of the target entity

**Example:**
```json
{
  "operation": "delete_entity_edge",
  "source_entity": "user",
  "target_entity": "old_preference"
}
```

## When NOT to Use
- User is asking about kitchen/recipes (use kitchen-orchestrator skill instead)
- User needs financial tracking (use surefinance skill instead)
- User needs project management (use huly skill instead)
- User is asking about 3D modeling or VFX (use houdini skill instead)
