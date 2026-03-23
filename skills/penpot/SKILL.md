---
name: penpot
description: Design tool (Penpot) — import images, export shapes as PNG/SVG, query API docs.
---

# Penpot Design Tool

Import images, export design shapes as PNG or SVG, and query Penpot API documentation for design file operations.

## When to Use

- Importing images into design files
- Exporting design shapes and assets
- Querying Penpot API documentation
- Getting design file information and structure
- Converting design elements to image formats

## Tools

### import_image

Import an image file into a Penpot design file.

**Parameters:**

- `file_id` (required) — Penpot design file ID
- `image_path` (required) — Local path to the image file to import
- `page_id` (optional) — Target page ID in the design file
- `x` (optional) — X coordinate for image placement (default: 0)
- `y` (optional) — Y coordinate for image placement (default: 0)

**Example:**

```json
{
  "file_id": "507f1f77bcf86cd799439011",
  "image_path": "/tmp/logo.png",
  "page_id": "page-1",
  "x": 100,
  "y": 50
}
```

### export_shape

Export a design shape or element as PNG or SVG format.

**Parameters:**

- `file_id` (required) — Penpot design file ID
- `shape_id` (required) — ID of the shape to export
- `format` (required) — Export format: "png" or "svg"
- `output_path` (required) — Local path for the exported file
- `scale` (optional) — Scale factor for export (default: 1.0)

**Example:**

```json
{
  "file_id": "507f1f77bcf86cd799439011",
  "shape_id": "shape-42",
  "format": "svg",
  "output_path": "/tmp/exported-shape.svg",
  "scale": 2.0
}
```

### penpot_api_info

Query Penpot API documentation and endpoint information.

**Parameters:**

- `query` (optional) — Search query for API documentation
- `endpoint` (optional) — Specific API endpoint to query
- `include_examples` (optional) — Include code examples (default: true)

**Example:**

```json
{
  "query": "file operations",
  "include_examples": true
}
```

### high_level_overview

Get a high-level overview of a design file structure, pages, and elements.

**Parameters:**

- `file_id` (required) — Penpot design file ID
- `include_metadata` (optional) — Include file metadata (default: true)
- `include_layers` (optional) — Include layer hierarchy (default: true)

**Example:**

```json
{
  "file_id": "507f1f77bcf86cd799439011",
  "include_metadata": true,
  "include_layers": true
}
```

## When NOT to Use

- Do not use for real-time collaborative editing
- Do not use for user authentication or account management
- Do not use for bulk design file operations without validation
- Do not use for accessing other users' private design files
