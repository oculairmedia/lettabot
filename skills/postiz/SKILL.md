---
name: postiz
description: Social media management — create posts, view scheduled/published content, check connected integrations.
---

# Postiz

Social media management platform for creating and scheduling posts across multiple platforms, viewing post history, and managing connected social media integrations.

## When to Use
- Need to create or schedule social media posts
- Want to view scheduled or published posts
- Need to check which social platforms are connected
- Want to manage multi-platform social media presence
- Need to draft posts for Twitter, LinkedIn, or other platforms

## Tools

### get-posts
Retrieve scheduled and published posts.

**Parameters:**
- `status` (optional) — Filter by post status: "scheduled", "published", or "all"
- `limit` (optional) — Maximum number of posts to return
- `offset` (optional) — Number of posts to skip for pagination

**Example:**
```json
{
  "status": "published",
  "limit": 20,
  "offset": 0
}
```

### create-post
Create a new post for social media platforms.

**Parameters:**
- `content` (required) — Post text content
- `platforms` (required) — List of platform names to post to (e.g., ["twitter", "linkedin"])
- `schedule_time` (optional) — ISO 8601 timestamp for scheduled posting
- `media_urls` (optional) — List of image/video URLs to attach

**Example:**
```json
{
  "content": "Excited to announce our new feature launch!",
  "platforms": ["twitter", "linkedin"],
  "schedule_time": "2025-03-10T14:00:00Z",
  "media_urls": ["https://example.com/image.jpg"]
}
```

### get-integrations
List all connected social media integrations and their status.

**Parameters:**
- None

**Example:**
```json
{}
```

## When NOT to Use
- For direct messaging or private communications
- When you need to moderate comments or engage in conversations
- For analytics and detailed post performance metrics
- When you need to manage multiple accounts on the same platform
- For content calendar planning beyond basic scheduling
