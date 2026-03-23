---
name: review-gate
description: Route work through a reviewer agent before accepting. Use for approval workflows, code review, security review, etc.
---

# Review Gate

A lightweight approval pattern: send work to a reviewer agent, get back approve/reject/revise, and act on the verdict. Simpler than a full council when you just need one expert's sign-off.

## When to Use

- Code changes that need security review before merge
- Infrastructure changes that need ops approval
- Content that needs editorial review
- Any workflow where "do the work, then get it checked" applies
- When you want a second opinion but not a full council

## The Pattern

```
[Implementer] → work artifact → [Reviewer] → verdict → [Implementer acts on verdict]
```

1. **Do the work** — implement the change, write the code, draft the content
2. **Submit for review** — send the artifact to a reviewer agent
3. **Get the verdict** — approved, rejected, or needs revision
4. **Act on it** — merge if approved, fix if revision needed, abandon if rejected

## Step 1: Pick a Reviewer

### By role
```json
{
  "role": "reviewer",
  "status": "active"
}
```

### By expertise (semantic search)
```json
{
  "query": "security authentication expert",
  "limit": 3
}
```

### By team assignment
If you have a standing review team:
```json
{
  "action": "get",
  "team_id": "security-review-committee"
}
```

## Step 2: Submit for Review

Send the artifact with clear review instructions:

```json
{
  "operation": "talk_to_agent",
  "agent": "Huly - LettaBot",
  "message": "REVIEW REQUEST:\n\nI've implemented rate limiting on the /api/v1/agents/register endpoint.\n\nChanges:\n- Added flask-limiter with 10 requests/minute per IP\n- Added 429 response with Retry-After header\n- Added rate limit bypass for internal service IPs\n\nPlease review for:\n1. Security: Are the limits appropriate?\n2. Correctness: Any edge cases missed?\n3. Operations: Will this break existing integrations?\n\nRespond with: APPROVED, REVISION NEEDED (with specifics), or REJECTED (with reason).",
  "caller_directory": "/opt/stacks/your-project"
}
```

## Step 3: Act on the Verdict

### If APPROVED
Proceed with the change (merge, deploy, etc.)

### If REVISION NEEDED
Fix the issues, then re-submit using conversation threading:
```json
{
  "operation": "letta_chat",
  "agent_name": "Huly - LettaBot",
  "message": "REVISION: Updated rate limits to 30/min based on your feedback. Also added whitelist for the sync service IP. Please re-review.",
  "conversation_id": "conv-from-review"
}
```

### If REJECTED
Report to the user with the reviewer's reasoning.

## Multi-Reviewer Gate

For high-stakes changes, require approval from multiple reviewers:

```json
{
  "operation": "parallel_dispatch",
  "targets": [
    {
      "agent": "Huly - LettaBot",
      "message": "REVIEW REQUEST [Security]: <artifact description>. Respond: APPROVED / REVISION NEEDED / REJECTED."
    },
    {
      "agent": "Huly - Matrix Synapse Deployment",
      "message": "REVIEW REQUEST [Operations]: <artifact description>. Respond: APPROVED / REVISION NEEDED / REJECTED."
    }
  ]
}
```

**Merge rules:**
- **All approve** → proceed
- **Any reject** → stop and report
- **Mixed (some revision needed)** → fix and re-submit to those reviewers

## Review Request Template

Prefix review messages with `REVIEW REQUEST:` and include:

```
REVIEW REQUEST:

**What:** Brief description of the change
**Why:** Motivation / ticket reference
**Changes:** Bullet list of what changed
**Review focus:** What specifically to evaluate
**Respond with:** APPROVED / REVISION NEEDED (specifics) / REJECTED (reason)
```

## Tips

- **Be specific about review criteria** — "review this" is too vague, "check for SQL injection in the query builder" is actionable
- **Include the artifact** — don't make the reviewer go find it
- **Use conversation threading** for revision cycles — keeps context intact
- **Don't gate trivial changes** — typo fixes don't need security review
- **Set expectations** — tell the reviewer what format you want the verdict in

## When to Use Council Instead

Use a full **agent-council** when:
- The decision is open-ended (not approve/reject)
- You need perspectives from 3+ different domains
- There's no clear "right answer" — you need deliberation
- The question is "should we do X?" rather than "is X done correctly?"

## Prerequisites

- `messaging-agents` skill (for `talk_to_agent` and `parallel_dispatch`)
- `agent-registry` skill (for finding reviewers by role)

## Related Skills

- **agent-council**: Full deliberation when you need more than approve/reject
- **messaging-agents**: The transport layer for review communication
- **agent-registry**: Find reviewer agents by role or capability
