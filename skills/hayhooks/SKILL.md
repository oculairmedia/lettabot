---
name: hayhooks
description: Haystack AI pipelines for web search with RAG, document ingestion, and intelligent search.
---

# Hayhooks

Haystack AI pipelines (Hayhooks) — web search with RAG, document ingestion/search, URL extraction, StackOverflow search, Zotero academic search, stack trace analysis, and Google authentication. Provides comprehensive research and document management capabilities.

## When to Use

- Searching the web with retrieval-augmented generation (RAG)
- Ingesting and searching documents
- Extracting URLs from content
- Searching StackOverflow for technical solutions
- Searching Zotero for academic papers
- Analyzing stack traces for debugging
- Authenticating with Google services

## Tools

### excerpt
Extract relevant excerpts from documents or web content.

**Parameters:**
- `content` (required) — The text content to extract excerpts from
- `query` (required) — The search query to find relevant excerpts
- `max_length` (optional) — Maximum length of each excerpt in characters

**Example:**
```json
{
  "content": "Long document text here...",
  "query": "machine learning algorithms",
  "max_length": 500
}
```

### search_stackoverflow
Search StackOverflow for technical questions and answers.

**Parameters:**
- `query` (required) — The search query for StackOverflow
- `limit` (optional) — Maximum number of results to return (default: 10)
- `tags` (optional) — Filter by tags (comma-separated)

**Example:**
```json
{
  "query": "python async await",
  "limit": 5,
  "tags": "python,async"
}
```

### ingest_document
Ingest and index a document for later search.

**Parameters:**
- `document_path` (required) — Path to the document file
- `document_type` (optional) — Type of document (pdf, txt, docx, etc.)
- `metadata` (optional) — Additional metadata as key-value pairs

**Example:**
```json
{
  "document_path": "/path/to/document.pdf",
  "document_type": "pdf",
  "metadata": {"author": "John Doe", "year": 2024}
}
```

### provision_search_agent
Create and provision a search agent for specialized queries.

**Parameters:**
- `agent_name` (required) — Name for the new search agent
- `search_type` (required) — Type of search (web, documents, academic)
- `config` (optional) — Agent configuration options

**Example:**
```json
{
  "agent_name": "research-agent",
  "search_type": "academic",
  "config": {"max_results": 20}
}
```

### google_auth
Authenticate with Google services.

**Parameters:**
- `service` (required) — Google service to authenticate (gmail, drive, scholar, etc.)
- `scopes` (optional) — OAuth scopes to request

**Example:**
```json
{
  "service": "drive",
  "scopes": ["https://www.googleapis.com/auth/drive.readonly"]
}
```

### letta_proxy
Proxy requests to Letta agents through Hayhooks.

**Parameters:**
- `agent_id` (required) — Letta agent ID
- `message` (required) — Message to send to the agent
- `context` (optional) — Additional context for the agent

**Example:**
```json
{
  "agent_id": "agent-123",
  "message": "Search for information about X",
  "context": {"source": "hayhooks"}
}
```

### extract
Extract structured data from unstructured content.

**Parameters:**
- `content` (required) — The content to extract from
- `extraction_type` (required) — Type of extraction (entities, tables, links, etc.)
- `schema` (optional) — Expected output schema

**Example:**
```json
{
  "content": "Contact us at support@example.com or call 555-1234",
  "extraction_type": "entities",
  "schema": {"email": "string", "phone": "string"}
}
```

### search_documents
Search previously ingested documents.

**Parameters:**
- `query` (required) — Search query
- `limit` (optional) — Maximum number of results
- `filters` (optional) — Filter by metadata

**Example:**
```json
{
  "query": "machine learning",
  "limit": 10,
  "filters": {"year": 2024}
}
```

### search
Perform a general web search with RAG.

**Parameters:**
- `query` (required) — Search query
- `limit` (optional) — Maximum results to return
- `rag_enabled` (optional) — Enable retrieval-augmented generation (default: true)

**Example:**
```json
{
  "query": "latest AI developments",
  "limit": 5,
  "rag_enabled": true
}
```

### analyze_trace
Analyze stack traces for debugging information.

**Parameters:**
- `trace` (required) — The stack trace to analyze
- `language` (optional) — Programming language of the trace
- `context` (optional) — Additional context about the error

**Example:**
```json
{
  "trace": "Traceback (most recent call last):\n  File \"app.py\", line 10, in <module>\n    result = divide(10, 0)\nZeroDivisionError: division by zero",
  "language": "python",
  "context": "Error occurred during data processing"
}
```

### search_zotero
Search Zotero library for academic papers and references.

**Parameters:**
- `query` (required) — Search query for academic papers
- `limit` (optional) — Maximum number of results
- `collections` (optional) — Filter by Zotero collections

**Example:**
```json
{
  "query": "neural networks deep learning",
  "limit": 10,
  "collections": ["AI Research"]
}
```

## When NOT to Use

- For simple keyword searches without context — use basic search engines instead
- When you need real-time stock prices or live data feeds — Hayhooks is document-focused
- For private/confidential document ingestion without proper security setup
- When you need to modify documents — Hayhooks is read-only for search
- For tasks that don't require RAG or document context
