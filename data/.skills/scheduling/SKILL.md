---
name: scheduling
description: Create scheduled tasks and one-off reminders. Use for recurring jobs (daily, weekly) or future reminders (in 5 minutes, tomorrow at 3pm).
---

# Scheduling

Schedule recurring tasks or one-off reminders.

## Quick Reference

```bash
lettabot-schedule list                    # List all jobs
lettabot-schedule create [options]        # Create job
lettabot-schedule delete ID               # Delete job
lettabot-schedule enable ID               # Enable job
lettabot-schedule disable ID              # Disable job
```

## One-Off Reminders (--at)

For reminders at a specific future time, use `--at` with an **ISO datetime**.

**Calculate the datetime in JavaScript:**
```javascript
// 5 minutes from now
new Date(Date.now() + 5*60*1000).toISOString()
// → "2026-01-28T20:15:00.000Z"

// 1 hour from now
new Date(Date.now() + 60*60*1000).toISOString()

// Tomorrow at 9am (approximate)
new Date(Date.now() + 24*60*60*1000).toISOString()
```

**Create the reminder:**
```bash
lettabot-schedule create \
  --name "Standup" \
  --at "2026-01-28T20:15:00.000Z" \
  --message "Time for standup!"
```

One-off reminders auto-delete after running.

**Options:**
- `-n, --name` - Job name (required)
- `-a, --at` - ISO datetime for one-off reminder (e.g., "2026-01-28T20:15:00Z")
- `-m, --message` - Message sent to you when job runs (required)
- `-d, --deliver` - Where to send response (format: `channel:chatId`). Defaults to last messaged chat.

## Recurring Schedules (--schedule)

For recurring tasks, use `--schedule` with a cron expression.

```bash
lettabot-schedule create \
  --name "Morning Briefing" \
  --schedule "0 8 * * *" \
  --message "Good morning! What's on today's agenda?"
```

**Options:**
- `-n, --name` - Job name (required)
- `-s, --schedule` - Cron expression (required for recurring)
- `-m, --message` - Message sent to you when job runs (required)
- `-d, --deliver` - Where to send response (format: `channel:chatId`). Defaults to last messaged chat.
- `--disabled` - Create disabled

## Cron Schedule Syntax

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)  
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sun=0)
* * * * *
```

| Pattern | When |
|---------|------|
| `0 8 * * *` | Daily at 8:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `30 17 * * 5` | Fridays at 5:30 PM |
| `0 0 1 * *` | First of month at midnight |

## Examples

**Remind me in 30 minutes:**
```bash
# First calculate: new Date(Date.now() + 30*60*1000).toISOString()
lettabot-schedule create \
  -n "Break reminder" \
  --at "2026-01-28T20:45:00.000Z" \
  -m "Time for a break!"
```

**Daily morning check-in:**
```bash
lettabot-schedule create \
  -n "Morning" \
  -s "0 8 * * *" \
  -m "Good morning! What's on today's agenda?"
```

**Weekly review on Fridays:**
```bash
lettabot-schedule create \
  -n "Weekly Review" \
  -s "0 17 * * 5" \
  -m "Friday wrap-up: What did we accomplish?"
```

## Message Format

When a scheduled job runs, you receive:

```
[cron:job-123abc Morning] Good morning! What's on today's agenda?
Current time: 1/27/2026, 8:00:00 AM (America/Los_Angeles)
```

## Notes

- Jobs activate immediately when created (no restart needed)
- One-off reminders (`--at`) auto-delete after running
- Use `lettabot-schedule list` to see next run times
- Jobs persist in `cron-jobs.json`
