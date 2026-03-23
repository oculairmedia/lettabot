---
name: bookstack
description: Documentation wiki (BookStack) — semantic/hybrid search across wiki content.
---

# BookStack Documentation Wiki

Semantic and hybrid search across internal documentation, runbooks, notes, and knowledge base articles stored in BookStack.

## When to Use

- Looking up internal documentation or runbooks
- Searching knowledge base articles
- Finding notes or reference materials
- Querying wiki content with natural language

## Tools

### bookstack_semantic_search

Performs semantic and hybrid search across BookStack wiki content to find relevant documentation and knowledge base articles.

**Parameters:**

- `query` (required) — Search query string for finding documentation
- `search_type` (optional) — Type of search: "semantic", "hybrid", or "full_text" (default: "hybrid")
- `limit` (optional) — Maximum number of results to return (default: 10)

**Example:**

```json
{
  "query": "how to deploy to production",
  "search_type": "hybrid",
  "limit": 5
}
```

## When NOT to Use

- Do not use for real-time system monitoring or status checks
- Do not use for creating or editing wiki content directly
- Do not use for accessing external documentation sources
- Do not use when you need live system metrics or logs
