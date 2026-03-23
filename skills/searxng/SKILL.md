---
name: searxng
description: Web search and content retrieval — search the web, read URL content, fact-checking and research.
---

# SearXNG

Privacy-focused web search engine and URL content reader for searching information across the web and retrieving full page content from URLs.

## When to Use
- Need to search the web for information
- Want to read content from a specific URL
- Conducting research or fact-checking
- Looking for news, articles, or current information
- Need to verify information from web sources
- Researching topics without tracking concerns

## Tools

### searxng_web_search
Search the web for information using SearXNG.

**Parameters:**
- `query` (required) — Search query string
- `language` (optional) — Language code (e.g., "en", "de", "fr")
- `time_range` (optional) — Filter by time: "day", "week", "month", "year"
- `limit` (optional) — Maximum number of results to return

**Example:**
```json
{
  "query": "climate change 2025",
  "language": "en",
  "time_range": "month",
  "limit": 10
}
```

### web_url_read
Read and retrieve the full content of a URL.

**Parameters:**
- `url` (required) — Complete URL to read
- `format` (optional) — Output format: "text", "markdown", or "html"

**Example:**
```json
{
  "url": "https://example.com/article",
  "format": "markdown"
}
```

## When NOT to Use
- For real-time stock market or cryptocurrency data
- When you need authenticated access to paywalled content
- For searching private or internal networks
- When you need advanced search operators beyond basic queries
- For searching social media platforms (use platform-specific APIs)
