# LettaBot Project Instructions

## End-to-End Validation (MANDATORY)

**Never declare a deployment, merge, or runtime change "done" until an end-to-end test proves the full message path works.**

Build passing and unit tests green are necessary but NOT sufficient. The real validation is:

1. Start/restart the LettaBot process
2. Send a message to Meridian via Matrix (`talk_to_agent`)
3. Confirm Meridian replies with an actual response (not a canned error like "connection issue" or "queued")
4. Check LettaBot logs AND matrix-client logs for errors

### Why This Exists

On 2026-03-21, a merge + restart passed build and 2447 tests but failed at runtime because `GATEWAY_ENABLED=true` was not set. The Matrix client couldn't reach the WS gateway (`HTTP 404`), messages were silently buffered, and Meridian returned canned "temporary connection issue" responses. This was only caught by actually sending a message through the full chain.

### Runtime Environment Checklist

When restarting LettaBot, ensure these environment variables are set:

- `GATEWAY_ENABLED=true` — Required for the WS gateway endpoint (`/api/v1/agent-gateway`)
- Verify the matrix-client container can reach LettaBot's WS endpoint (check retry-buffer logs)

### How to Validate

```bash
# 1. Check LettaBot is running and gateway is up
tail -20 /tmp/lettabot.log  # Look for: "WebSocket gateway ready on /api/v1/agent-gateway"

# 2. Check matrix-client can connect
docker logs matrix-synapse-deployment-matrix-client-1 --tail 20 2>&1 | grep -E 'gateway|retry|buffer'
# Should NOT see "Gateway still down" — should see "Gateway reachable" or "Session established"

# 3. Send a test message via Matrix
# Use matrix_messaging tool: talk_to_agent -> Meridian -> confirm real response
```

## Project Details

- **Stack**: Matrix client runs in `matrix-synapse-deployment` docker compose stack
- **Process**: LettaBot runs directly on host as `node dist/main.js` (not containerized)
- **Config**: `lettabot.yaml` (contains credentials — never commit)
- **Logs**: `/tmp/lettabot.log`
- **Agent**: Meridian (`agent-597b5756-2915-4560-ba6b-91005f085166`)
- **Remotes**: `origin` = letta-ai/lettabot (upstream), `fork` = oculairmedia/lettabot (user's fork)

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
