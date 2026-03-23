---
name: crawl4ai
description: Web crawling and scraping — take screenshots, convert pages to markdown/HTML/PDF, execute JavaScript, crawl multiple URLs.
---

# Crawl4AI

Web crawling and scraping platform for capturing web pages in multiple formats, executing JavaScript, taking screenshots, and crawling multiple URLs in parallel.

## When to Use
- Need to take screenshots of web pages
- Want to convert web pages to markdown, HTML, or PDF
- Need to execute JavaScript on pages before capturing content
- Scraping multiple URLs in parallel
- Need to extract structured data from web pages
- Want to archive or convert web content to different formats

## Tools

### screenshot
Take a screenshot of a web page.

**Parameters:**
- `url` (required) — URL to screenshot
- `width` (optional) — Viewport width in pixels (default: 1920)
- `height` (optional) — Viewport height in pixels (default: 1080)
- `wait_time` (optional) — Milliseconds to wait before capturing

**Example:**
```json
{
  "url": "https://example.com",
  "width": 1920,
  "height": 1080,
  "wait_time": 2000
}
```

### md
Convert a web page to markdown format.

**Parameters:**
- `url` (required) — URL to convert
- `include_links` (optional) — Include hyperlinks in output (default: true)
- `include_images` (optional) — Include image references (default: true)

**Example:**
```json
{
  "url": "https://example.com/article",
  "include_links": true,
  "include_images": true
}
```

### html
Extract and return the HTML content of a web page.

**Parameters:**
- `url` (required) — URL to extract HTML from
- `clean` (optional) — Remove scripts and styles (default: false)

**Example:**
```json
{
  "url": "https://example.com",
  "clean": true
}
```

### pdf
Convert a web page to PDF format.

**Parameters:**
- `url` (required) — URL to convert to PDF
- `margin` (optional) — Page margin in millimeters
- `format` (optional) — Paper format: "A4", "Letter", etc.

**Example:**
```json
{
  "url": "https://example.com/document",
  "margin": 10,
  "format": "A4"
}
```

### execute_js
Execute JavaScript on a page and return results.

**Parameters:**
- `url` (required) — URL to execute JavaScript on
- `script` (required) — JavaScript code to execute
- `wait_time` (optional) — Milliseconds to wait for execution

**Example:**
```json
{
  "url": "https://example.com",
  "script": "return document.querySelectorAll('h1').length;",
  "wait_time": 3000
}
```

### crawl
Crawl multiple URLs in parallel and extract content.

**Parameters:**
- `urls` (required) — List of URLs to crawl
- `format` (optional) — Output format: "markdown", "html", or "text"
- `max_depth` (optional) — Maximum crawl depth for following links
- `parallel_requests` (optional) — Number of parallel requests (default: 5)

**Example:**
```json
{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "format": "markdown",
  "max_depth": 1,
  "parallel_requests": 5
}
```

## When NOT to Use
- For sites that explicitly forbid scraping in robots.txt
- When you need real-time data updates (use APIs instead)
- For authenticated/login-required pages without credentials
- When you need to preserve exact visual styling (use screenshots instead)
- For sites with heavy JavaScript that requires complex interaction
