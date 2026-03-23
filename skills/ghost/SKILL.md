---
name: ghost
description: Ghost blog management — list and manage blog tags.
---

# Ghost Blog Management

List and manage blog tags in Ghost blogging platform for content organization and tag management.

## When to Use

- Listing all blog tags
- Deleting unused or obsolete tags
- Organizing blog content by tags
- Managing blog taxonomy

## Tools

### list_ghost_tags

Retrieves a list of all tags in the Ghost blog with metadata.

**Parameters:**

- `limit` (optional) — Maximum number of tags to return (default: 100)
- `offset` (optional) — Number of tags to skip for pagination (default: 0)
- `include_count` (optional) — Include post count for each tag (default: true)

**Example:**

```json
{
  "limit": 50,
  "offset": 0,
  "include_count": true
}
```

### delete_ghost_tag

Deletes a tag from the Ghost blog by ID.

**Parameters:**

- `tag_id` (required) — The unique identifier of the tag to delete
- `cascade` (optional) — Whether to cascade delete posts with this tag (default: false)

**Example:**

```json
{
  "tag_id": "507f1f77bcf86cd799439011",
  "cascade": false
}
```

## When NOT to Use

- Do not use for creating new tags (use Ghost admin interface)
- Do not use for editing tag metadata or descriptions
- Do not use for bulk tag operations without confirmation
- Do not use for accessing post content directly
