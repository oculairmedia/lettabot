---
name: payloadcms
description: Headless CMS (Payload CMS) — manage collections, globals, media uploads, and health monitoring.
---

# Payload CMS Management

Manage collections, globals, media uploads, and monitor CMS health in Payload CMS headless content management system.

## When to Use

- Managing content collections and documents
- Uploading and managing media files
- Updating global site settings
- Monitoring CMS system health and status
- Querying CMS configuration and metadata

## Tools

### cms_collection_ops

Perform CRUD operations on CMS collections including create, read, update, and delete documents.

**Parameters:**

- `operation` (required) — Operation type: "list", "get", "create", "update", "delete"
- `collection` (required) — Collection name or ID
- `document_id` (optional) — Document ID for get/update/delete operations
- `data` (optional) — Document data for create/update operations
- `limit` (optional) — Maximum results for list operations (default: 10)

**Example:**

```json
{
  "operation": "list",
  "collection": "posts",
  "limit": 20
}
```

### cms_health_ops

Monitor and retrieve CMS system health status, uptime, and diagnostics.

**Parameters:**

- `check_type` (optional) — Type of health check: "full", "database", "storage", "api" (default: "full")
- `verbose` (optional) — Include detailed diagnostic information (default: false)

**Example:**

```json
{
  "check_type": "full",
  "verbose": true
}
```

### cms_global_ops

Manage global site settings and configuration values.

**Parameters:**

- `operation` (required) — Operation type: "get", "update"
- `key` (optional) — Specific global setting key to retrieve
- `data` (optional) — Global settings data for update operations

**Example:**

```json
{
  "operation": "get",
  "key": "site_title"
}
```

### cms_media_ops

Upload, manage, and organize media files in the CMS.

**Parameters:**

- `operation` (required) — Operation type: "upload", "list", "delete", "get_info"
- `file_path` (optional) — Local file path for upload operations
- `media_id` (optional) — Media file ID for delete/get_info operations
- `folder` (optional) — Target folder for organization (default: "root")

**Example:**

```json
{
  "operation": "upload",
  "file_path": "/tmp/image.jpg",
  "folder": "blog-images"
}
```

## When NOT to Use

- Do not use for user authentication or permission management
- Do not use for real-time content publishing workflows
- Do not use for bulk operations without proper validation
- Do not use for accessing user data or sensitive information
