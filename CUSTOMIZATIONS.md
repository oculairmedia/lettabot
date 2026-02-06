# LettaBot Customizations

Local customizations for oculairmedia deployment. When rebasing on upstream:

1. `git fetch upstream`
2. `git rebase upstream/main`
3. Resolve conflicts using this guide

---

## 1. Context Injection API (`feat/inject-api`)

**Files:** `src/api/server.ts`, `src/api/types.ts`

**Purpose:** Allow external services to inject context into the agent (like Gmail polling does internally).

**Endpoint:**
```
POST /api/v1/inject
X-Api-Key: <key>
{"text": "context", "source": "service-name"}
```

**Conflict resolution:** Add the `/api/v1/inject` route handler and types. Won't conflict unless upstream adds same endpoint.

---

## 2. Non-Terminal Result Handling (`fix/stream-non-terminal`)

**Files:** `src/core/bot.ts` (lines ~568, ~776)

**Purpose:** Don't break stream loop on non-terminal results (e.g., `requires_approval`). Let CLI complete its approval loop.

**Change:** Replace `break` with `continue` when `!resultMsg.success`

**Conflict resolution:** If upstream changes stream handling, ensure non-success results don't terminate the loop.

---

## 3. Sequential Tool Call Restriction (`fix/sequential-tools`)

**Files:** `src/core/system-prompt.ts`

**Purpose:** Prevent parallel tool calls which cause "Invalid tool call IDs" errors on Letta server.

**Change:** Added to system prompt:
```
# Tool Call Restrictions
**CRITICAL: You MUST call tools SEQUENTIALLY, one at a time.**
```

**Conflict resolution:** Add restriction text to whatever system prompt exists.

---

## 4. Approval Recovery Helpers (`fix/approval-recovery`)

**Files:** `src/tools/letta-api.ts`, `src/core/bot.ts`

**Purpose:** Recover from stuck approval states by approving orphaned approvals on startup.

**Changes:**
- Added `approveApproval()` function to letta-api.ts
- Added `disableAllToolApprovals()` call in bot constructor
- Added orphaned approval detection and recovery

**Conflict resolution:** Merge approval-related helpers carefully.

---

## Rebase Workflow

```bash
# Fetch upstream
git fetch upstream

# Rebase on upstream/main
git rebase upstream/main

# If conflicts, resolve using notes above, then:
git add .
git rebase --continue

# Push to fork (may need --force if rebased)
git push fork matrix-pr-42 --force-with-lease
```
