---
name: komodo
description: Infrastructure monitoring (Komodo) — check AI summarization status, manage cache.
---

# Komodo

Monitor infrastructure health and manage caching systems. Check summarization service status and optimize cache performance.

## When to Use

- Monitoring AI summarization service health
- Checking infrastructure status
- Managing cache performance
- Troubleshooting summarization issues
- Optimizing cache utilization

## Tools

### get_summarization_status

Check the current status of the AI summarization service.

**Parameters:**
- `service_id` (optional) — Specific service to check
- `detailed` (optional) — Return detailed metrics (boolean)

**Example:**
```json
{
  "service_id": "summarizer-1",
  "detailed": true
}
```

### manage_cache

Manage cache operations including clearing, warming, and optimization.

**Parameters:**
- `action` (required) — Operation: "clear", "warm", "stats", "optimize"
- `cache_key` (optional) — Specific cache key to target
- `ttl` (optional) — Time-to-live in seconds for cache entries

**Example:**
```json
{
  "action": "stats",
  "cache_key": "summarization_*"
}
```

## When NOT to Use

- For application-level caching (use application cache directly)
- For real-time performance monitoring (use dedicated monitoring tools)
- For cache invalidation in production without testing
- For managing user-facing cache (use CDN tools instead)
