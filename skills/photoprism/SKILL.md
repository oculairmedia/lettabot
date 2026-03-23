---
name: photoprism
description: Photo management and organization — search, browse, manage albums, batch operations, people/subject recognition.
---

# PhotoPrism

Photo management system for searching, browsing, organizing photos into albums, managing subjects/people, applying labels, and performing batch operations like favoriting, archiving, and deleting.

## When to Use
- Need to search or browse photos by label, subject, or content
- Want to organize photos into albums
- Need to batch favorite, archive, or delete photos
- Looking for photos of specific people or subjects
- Need to update photo metadata or privacy settings
- Want to check PhotoPrism system status

## Tools

### add_photos_to_album
Add photos to an existing album.

**Parameters:**
- `album_uid` (required) — Unique identifier of the album
- `photo_uids` (required) — List of photo UIDs to add

**Example:**
```json
{
  "album_uid": "album-123",
  "photo_uids": ["photo-1", "photo-2", "photo-3"]
}
```

### get_album
Retrieve album details including photos and metadata.

**Parameters:**
- `album_uid` (required) — Unique identifier of the album

**Example:**
```json
{
  "album_uid": "album-123"
}
```

### get_subject_photos
Get all photos associated with a specific subject (person).

**Parameters:**
- `subject_uid` (required) — Unique identifier of the subject
- `limit` (optional) — Maximum number of photos to return
- `offset` (optional) — Number of photos to skip for pagination

**Example:**
```json
{
  "subject_uid": "subject-456",
  "limit": 50,
  "offset": 0
}
```

### batch_update_photos
Update metadata for multiple photos at once.

**Parameters:**
- `photo_uids` (required) — List of photo UIDs to update
- `title` (optional) — New title for photos
- `description` (optional) — New description for photos
- `keywords` (optional) — New keywords/tags for photos

**Example:**
```json
{
  "photo_uids": ["photo-1", "photo-2"],
  "title": "Vacation 2025",
  "description": "Summer trip photos",
  "keywords": ["vacation", "summer"]
}
```

### batch_favorite_photos
Mark multiple photos as favorites.

**Parameters:**
- `photo_uids` (required) — List of photo UIDs to favorite

**Example:**
```json
{
  "photo_uids": ["photo-1", "photo-2", "photo-3"]
}
```

### list_labels
Get all available labels/tags in the library.

**Parameters:**
- `limit` (optional) — Maximum number of labels to return
- `offset` (optional) — Number of labels to skip for pagination

**Example:**
```json
{
  "limit": 100,
  "offset": 0
}
```

### list_albums
Get all albums in the library.

**Parameters:**
- `limit` (optional) — Maximum number of albums to return
- `offset` (optional) — Number of albums to skip for pagination

**Example:**
```json
{
  "limit": 50,
  "offset": 0
}
```

### get_status
Check PhotoPrism system status and configuration.

**Parameters:**
- None

**Example:**
```json
{}
```

### list_subjects
Get all recognized subjects (people) in the library.

**Parameters:**
- `limit` (optional) — Maximum number of subjects to return
- `offset` (optional) — Number of subjects to skip for pagination

**Example:**
```json
{
  "limit": 100,
  "offset": 0
}
```

### get_photos_by_label
Retrieve all photos with a specific label.

**Parameters:**
- `label_uid` (required) — Unique identifier of the label
- `limit` (optional) — Maximum number of photos to return
- `offset` (optional) — Number of photos to skip for pagination

**Example:**
```json
{
  "label_uid": "label-789",
  "limit": 50,
  "offset": 0
}
```

### update_photo
Update metadata for a single photo.

**Parameters:**
- `photo_uid` (required) — Unique identifier of the photo
- `title` (optional) — New title
- `description` (optional) — New description
- `keywords` (optional) — New keywords/tags

**Example:**
```json
{
  "photo_uid": "photo-1",
  "title": "Mountain Sunset",
  "description": "Beautiful sunset at the peak",
  "keywords": ["nature", "sunset"]
}
```

### batch_delete_photos
Permanently delete multiple photos.

**Parameters:**
- `photo_uids` (required) — List of photo UIDs to delete

**Example:**
```json
{
  "photo_uids": ["photo-1", "photo-2"]
}
```

### batch_private_photos
Mark multiple photos as private.

**Parameters:**
- `photo_uids` (required) — List of photo UIDs to make private

**Example:**
```json
{
  "photo_uids": ["photo-1", "photo-2", "photo-3"]
}
```

### search_photos
Search photos by query string, labels, subjects, or other criteria.

**Parameters:**
- `query` (required) — Search query string
- `limit` (optional) — Maximum number of results to return
- `offset` (optional) — Number of results to skip for pagination

**Example:**
```json
{
  "query": "beach sunset",
  "limit": 50,
  "offset": 0
}
```

### create_album
Create a new album.

**Parameters:**
- `title` (required) — Album title
- `description` (optional) — Album description

**Example:**
```json
{
  "title": "Summer Vacation 2025",
  "description": "Photos from our beach trip"
}
```

### batch_archive_photos
Mark multiple photos as archived.

**Parameters:**
- `photo_uids` (required) — List of photo UIDs to archive

**Example:**
```json
{
  "photo_uids": ["photo-1", "photo-2", "photo-3"]
}
```

### get_photo
Retrieve detailed information about a single photo.

**Parameters:**
- `photo_uid` (required) — Unique identifier of the photo

**Example:**
```json
{
  "photo_uid": "photo-1"
}
```

## When NOT to Use
- For video management (PhotoPrism is photo-focused)
- When you need real-time photo uploads from external sources
- For advanced AI image analysis beyond subject/people recognition
- When you need to edit photo content (cropping, filters, etc.)
