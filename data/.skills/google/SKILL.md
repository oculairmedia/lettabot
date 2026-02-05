---
name: google
description: Google Workspace CLI (gog) for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
---

# Google Workspace (gog)

Use `gog` CLI to interact with Google Workspace services.

## Setup

```bash
brew install steipete/tap/gogcli
gog auth credentials /path/to/credentials.json
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets
gog auth list
```

## Gmail

```bash
# Search emails
gog gmail search 'newer_than:1h is:unread' --account EMAIL --max 10
gog gmail search 'from:someone@example.com' --account EMAIL --max 10

# Read email
gog gmail get MESSAGE_ID --account EMAIL

# Send email
gog gmail send --to recipient@example.com --subject "Subject" --body "Message" --account EMAIL

# Reply to thread
gog gmail send --to recipient@example.com --subject "Re: Original" --body "Reply" --reply-to-message-id MSG_ID --account EMAIL

# Create/send draft
gog gmail drafts create --to recipient@example.com --subject "Subject" --body "Draft" --account EMAIL
gog gmail drafts send DRAFT_ID --account EMAIL

# Manage labels
gog gmail labels --account EMAIL
gog gmail modify MESSAGE_ID --add-labels LABEL --account EMAIL
gog gmail modify MESSAGE_ID --remove-labels UNREAD --account EMAIL
```

## Calendar

```bash
# List events
gog calendar events CALENDAR_ID --from 2026-01-27T00:00:00Z --to 2026-01-28T00:00:00Z --account EMAIL

# Create event
gog calendar create CALENDAR_ID --summary "Meeting" --from 2026-01-27T10:00:00Z --to 2026-01-27T11:00:00Z --account EMAIL

# Create with color (1-11)
gog calendar create CALENDAR_ID --summary "Meeting" --from ISO --to ISO --event-color 7 --account EMAIL

# Update event
gog calendar update CALENDAR_ID EVENT_ID --summary "New Title" --account EMAIL

# Show available colors
gog calendar colors
```

## Drive

```bash
# Search files
gog drive search "query" --max 10 --account EMAIL

# List files in folder
gog drive list FOLDER_ID --account EMAIL

# Download file
gog drive download FILE_ID --out /path/to/file --account EMAIL

# Upload file
gog drive upload /path/to/file --parent FOLDER_ID --account EMAIL
```

## Contacts

```bash
# List contacts
gog contacts list --max 20 --account EMAIL

# Search contacts
gog contacts search "name" --account EMAIL
```

## Sheets

```bash
# Read range
gog sheets get SHEET_ID "Sheet1!A1:D10" --json --account EMAIL

# Update cells
gog sheets update SHEET_ID "Sheet1!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED --account EMAIL

# Append rows
gog sheets append SHEET_ID "Sheet1!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS --account EMAIL

# Clear range
gog sheets clear SHEET_ID "Sheet1!A2:Z" --account EMAIL

# Get metadata
gog sheets metadata SHEET_ID --json --account EMAIL
```

## Docs

```bash
# Read document
gog docs cat DOC_ID --account EMAIL

# Export to file
gog docs export DOC_ID --format txt --out /tmp/doc.txt --account EMAIL
```

## Environment

Set default account in `.env`:
```bash
GMAIL_ACCOUNT=you@gmail.com
```

## Email Polling

Emails are polled every 1 minute via cron. Use `ignore()` if nothing important.
