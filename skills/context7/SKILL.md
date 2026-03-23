---
name: context7
description: Library documentation lookup (Context7) — resolve library names and fetch up-to-date documentation.
---

# Context7

Resolve library names to IDs and fetch comprehensive documentation. Access API docs, usage examples, and reference material for programming libraries and frameworks.

## When to Use

- Looking up API documentation
- Finding usage examples for libraries
- Resolving library names to identifiers
- Accessing reference material
- Getting framework documentation
- Finding library version information

## Tools

### resolve-library-id

Resolve a library name to its Context7 ID.

**Parameters:**
- `library_name` (required) — Name of the library or framework
- `version` (optional) — Specific version to resolve
- `language` (optional) — Programming language filter

**Example:**
```json
{
  "library_name": "React",
  "version": "18.0",
  "language": "JavaScript"
}
```

### get-library-docs

Fetch documentation for a library by its Context7 ID.

**Parameters:**
- `library_id` (required) — Context7 library ID
- `section` (optional) — Specific documentation section
- `format` (optional) — Output format: "markdown", "html", "json"
- `include_examples` (optional) — Include code examples (boolean)

**Example:**
```json
{
  "library_id": "lib-react-18",
  "section": "hooks",
  "format": "markdown",
  "include_examples": true
}
```

## When NOT to Use

- For downloading library source code (use package managers)
- For installing libraries (use npm, pip, etc.)
- For community discussions (use Stack Overflow or forums)
- For outdated library versions (documentation may not be available)
