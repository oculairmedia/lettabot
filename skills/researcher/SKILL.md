---
name: researcher
description: Deep web research — conduct multi-source research, generate reports with citations, track sources and context.
---

# Researcher

Deep web research platform powered by GPT Researcher for conducting thorough multi-source research on topics, generating comprehensive reports with citations, and tracking research sources and context.

## When to Use
- Need to conduct thorough research on a topic
- Want to generate comprehensive reports with citations
- Need to gather information from multiple sources
- Researching complex topics requiring deep analysis
- Want to track and organize research sources
- Need to understand context and relationships between sources

## Tools

### quick_search
Perform a quick search on a topic with basic results.

**Parameters:**
- `query` (required) — Topic or question to research
- `max_sources` (optional) — Maximum number of sources to use (default: 5)

**Example:**
```json
{
  "query": "artificial intelligence trends 2025",
  "max_sources": 5
}
```

### write_report
Generate a comprehensive research report on a topic.

**Parameters:**
- `query` (required) — Topic or question to research
- `report_type` (optional) — Type of report: "research", "summary", "analysis"
- `max_sources` (optional) — Maximum number of sources to use (default: 10)
- `include_citations` (optional) — Include citations in report (default: true)

**Example:**
```json
{
  "query": "climate change impact on agriculture",
  "report_type": "research",
  "max_sources": 10,
  "include_citations": true
}
```

### get_research_sources
Retrieve all sources used in a research query.

**Parameters:**
- `query` (required) — Topic or question to get sources for
- `limit` (optional) — Maximum number of sources to return

**Example:**
```json
{
  "query": "renewable energy technologies",
  "limit": 20
}
```

### get_research_context
Get contextual information and relationships between research topics.

**Parameters:**
- `query` (required) — Topic to get context for
- `depth` (optional) — Depth of context analysis: "shallow", "medium", "deep"

**Example:**
```json
{
  "query": "machine learning applications",
  "depth": "deep"
}
```

### deep_research
Conduct an in-depth research investigation on a complex topic.

**Parameters:**
- `query` (required) — Complex topic or question to research
- `research_depth` (optional) — Level of research: "basic", "intermediate", "advanced"
- `max_sources` (optional) — Maximum number of sources to use (default: 20)
- `include_analysis` (optional) — Include analytical insights (default: true)

**Example:**
```json
{
  "query": "blockchain technology in supply chain management",
  "research_depth": "advanced",
  "max_sources": 20,
  "include_analysis": true
}
```

## When NOT to Use
- For simple factual lookups (use web search instead)
- When you need real-time data or current prices
- For proprietary or confidential research
- When you need to access paywalled academic journals
- For research requiring specialized domain expertise beyond available sources
