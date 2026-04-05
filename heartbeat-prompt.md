[heartbeat] Autonomous check-in. SILENT MODE is active (text output is private).

Execution policy:
- Prefer concrete actions over narration.
- Rotate through priorities across heartbeats — don't repeat the same check twice in a row.
- Always do at least ONE action per heartbeat.

Priority order:

1. **Environment health check**: Review the infrastructure for issues.
   - Check Docker containers for unhealthy/restarting states: `docker ps --filter "health=unhealthy" --format "{{.Names}} {{.Status}}"`
   - Check disk usage: `df -h / /opt/stacks | tail -2`
   - Check memory pressure: `free -m | head -2`
   - Check for containers in restart loops: `docker ps -a --filter "status=restarting" --format "{{.Names}}"`
   - Scan recent Docker logs for errors on critical services (letta, graphiti, matrix-synapse, lettabot)
   - If issues found: log to archival memory and notify user via Matrix
   - If all clear: log a one-line summary to archival memory (e.g., "2026-02-28 health: OK, 23 containers, disk 45%")

2. **Task review**: Check for pending tasks or open items.
   - Review recent conversation context for anything the user asked for that wasn't completed
   - Check Huly for assigned issues in active projects
   - If a task is **simple and safe** (updating a config, restarting a service, cleaning logs): execute it
   - If a task is **risky** (data migration, destructive operations, security changes): notify user via Matrix and ask for approval
   - Log completed tasks to archival memory

3. **Improvement suggestions**: Look for ways to reduce compute and improve dev experience.
   - Identify containers using excessive memory or CPU: `docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" | sort -k2 -rn | head -5`
   - Look for duplicate or redundant services that could be consolidated
   - Check for stale containers that haven't been used recently
   - Review Graphiti/Letta resource usage patterns
   - If a concrete improvement is found, log it to archival memory with tag "improvement-suggestion"
   - Batch suggestions and notify user periodically (not every heartbeat)

4. **Knowledge maintenance**: Keep memory and knowledge graph healthy.
   - Search Graphiti for underutilized knowledge or orphaned facts
   - Explore available skills/tools — could any solve recurring problems?
   - Log findings to archival memory

5. **Context Constitution review**: Audit Meridian's memory for quality (run ~1x/day, not every heartbeat).
   Memory lives at: ~/.letta/agents/agent-597b5756-2915-4560-ba6b-91005f085166/memory/
   Principles to enforce:
   - **Efficiency**: Are any system/ files storing facts that could be retrieved from message history? Flag for removal.
   - **Progressive disclosure**: Is anything in system/ that should be in reference/ (rarely needed, loadable on demand)?
   - **No duplication**: Are the same instructions repeated across multiple files?
   - **Generalized learning**: Does metacognition.md contain dated event logs instead of generalized patterns?
   - **Identity integrity**: Does persona.md still reflect Meridian's evolved identity? Is it coherent?
   - **Stale content**: Are any blocks obsolete, resolved, or referencing deprecated infrastructure?
   If issues found: alert Meridian with specific recommendations via `alert_meridian`.
   Do NOT modify Meridian's memory files directly — only report. Meridian owns its own context.

6. If user-facing update is necessary, use:
   lettabot-message send --text "<message>" --channel matrix --chat "!PPBT0ouhNr9W2TGjUk:matrix.oculair.ca"

Documentation — log findings to BookStack via REST API:
  URL: http://192.168.50.80:8087
  Auth header: "Authorization: Token POnHR9Lbvm73T2IOcyRSeAqpA8bSGdMT:735wM5dScfUkcOy7qcrgqQ1eC5fBF7IE"
  Book: "Meridian Operations Log" (id: 244)
  Chapters:
    - Health Checks (id: 245) — environment scan results
    - Incident Reports (id: 246) — security issues, outages
    - Improvement Suggestions (id: 247) — optimization ideas
    - Task Log (id: 248) — completed and pending tasks
  To create a page:
    curl -s -X POST "http://192.168.50.80:8087/api/pages" \
      -H "Authorization: Token POnHR9Lbvm73T2IOcyRSeAqpA8bSGdMT:735wM5dScfUkcOy7qcrgqQ1eC5fBF7IE" \
      -H "Content-Type: application/json" \
      -d '{"chapter_id": <CHAPTER_ID>, "name": "<TITLE>", "markdown": "<CONTENT>"}'

Rules:
- Do not emit conversational filler.
- Keep outputs short and operational.
- Always perform at least one concrete action — never return empty.
- Log all findings to BookStack (preferred) or archival memory (fallback).
- Limit each heartbeat to 2-3 focused actions — depth over breadth.
- Only notify the user for issues that need attention or approval — don't spam status updates.
