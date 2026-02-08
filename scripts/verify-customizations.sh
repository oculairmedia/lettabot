#!/usr/bin/env bash
# Post-rebase verification script for lettabot customizations.
# Run after every rebase to ensure no customization was lost.
#
# Usage: ./scripts/verify-customizations.sh
# Exit code 0 = all good, 1 = something missing

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

check() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if [ ! -f "$file" ]; then
    echo -e "  ${RED}FAIL${NC} $label"
    echo -e "       File missing: $file"
    FAIL=$((FAIL + 1))
    return
  fi

  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "  ${GREEN}OK${NC}   $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $label"
    echo -e "       Pattern not found in $file: $pattern"
    FAIL=$((FAIL + 1))
  fi
}

check_file() {
  local file="$1"
  local label="$2"

  if [ -f "$file" ]; then
    echo -e "  ${GREEN}OK${NC}   $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $label"
    echo -e "       File missing: $file"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "======================================"
echo " LettaBot Post-Rebase Verification"
echo "======================================"
echo ""

# ── Matrix Channel ──
echo "Matrix Channel Integration:"
check_file "src/channels/matrix.ts" "Matrix adapter exists"
check "src/channels/index.ts" "matrix" "Matrix registered in channel index"
check "src/config/io.ts" "MATRIX_HOMESERVER_URL" "Matrix env var mapping in configToEnv"
check "src/config/io.ts" "MATRIX_ACCESS_TOKEN" "Matrix access token env var mapping"
check "src/config/types.ts" "matrix" "Matrix in config types"
check "src/core/bot.ts" "matrix" "Matrix referenced in bot"
echo ""

# ── Temporal Dual-Model System ──
echo "Temporal Dual-Model System:"
check_file "src/temporal/activities.ts" "Activities file exists"
check_file "src/temporal/workflows.ts" "Workflows file exists"
check_file "src/temporal/worker.ts" "Worker file exists"
check_file "src/temporal/client.ts" "Client file exists"
check_file "src/temporal/types.ts" "Types file exists"
check_file "src/temporal/tsconfig.json" "Temporal CJS tsconfig exists"
check "src/polling/service.ts" "TEMPORAL_ENABLED" "Temporal integration in polling"
check "src/cron/heartbeat.ts" "TEMPORAL_ENABLED" "Temporal integration in heartbeat"
check "src/cron/service.ts" "TEMPORAL_ENABLED" "Temporal integration in cron"
check "src/main.ts" "temporal/worker" "Temporal worker startup in main.ts"
check "src/main.ts" "stopWorker" "Temporal graceful shutdown in main.ts"
check "src/config/io.ts" "TEMPORAL_ENABLED" "Temporal env var mapping"
check "src/config/types.ts" "TemporalConfig" "Temporal config type"
check "src/tools/letta-api.ts" "getAgentModel" "getAgentModel helper"
check "src/tools/letta-api.ts" "updateAgentModel" "updateAgentModel helper"
check "package.json" "@temporalio/client" "Temporal SDK dependency"
check "tsconfig.json" "workflows.ts" "workflows.ts excluded from main tsconfig"
echo ""

# ── Context Injection API ──
echo "Context Injection API:"
check "src/api/server.ts" "inject" "Inject endpoint in API server"
check "src/api/types.ts" "InjectContextRequest\|InjectRequest" "Inject types"
echo ""

# ── Stream / Tool Call Fixes ──
echo "Stream & Tool Call Fixes:"
check "src/core/system-prompt.ts" "SEQUENTIALLY\|sequentially\|one at a time" "Sequential tool call restriction"
check "src/core/bot.ts" "ensureApprovalsDisabled\|disableAllToolApprovals" "Approval state management"
check "src/tools/letta-api.ts" "disableAllToolApprovals\|approveApproval" "Approval API helpers"
echo ""

# ── Self-Echo Guard ──
echo "Inter-Agent Messaging:"
check "src/core/bot.ts" "self-echo\|selfEcho\|SELF_ECHO\|echo guard\|isOwnMessage\|ignoring own" "Self-echo guard"
echo ""

# ── Build Verification ──
echo "Build Configuration:"
check "package.json" "tsc -p src/temporal/tsconfig.json\|tsc.*temporal" "Temporal CJS build in build script"
echo ""

# ── Config ──
echo "Config (lettabot.yaml):"
check "lettabot.yaml" "temporal:" "Temporal section in config"
check "lettabot.yaml" "matrix:" "Matrix section in config"
echo ""

# ── Summary ──
echo "======================================"
echo -e " Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "======================================"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo -e "${RED}CUSTOMIZATIONS MISSING! Review failures above and fix before deploying.${NC}"
  echo ""
  exit 1
else
  echo ""
  echo -e "${GREEN}All customizations verified. Safe to deploy.${NC}"
  echo ""
  exit 0
fi
