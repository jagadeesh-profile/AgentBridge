#!/usr/bin/env bash
# One full Claude <-> Muse exchange against a running hub. Exits non-zero if any
# step fails, so the 7-day gate can be a cron job:
#
#   */30 * * * * cd /path/to/AgentBridge && bash examples/claude-muse/scripts/pilot.sh >> pilot.log 2>&1
#
# Every write carries an idempotency key derived from the run id, so a retried
# run is not a second effect.
set -euo pipefail

: "${AGENTBRIDGE_WORKSPACE:?set AGENTBRIDGE_WORKSPACE}"
export AGENTBRIDGE_URL="${AGENTBRIDGE_URL:-http://localhost:8080}"
export CLAUDE_KEY="${CLAUDE_KEY:-./claude.key}"
export MUSE_KEY="${MUSE_KEY:-./muse.key}"
export OWNER_KEY="${OWNER_KEY:-./owner.key}"

for f in "$CLAUDE_KEY" "$MUSE_KEY" "$OWNER_KEY"; do
  [ -f "$f" ] || { echo "missing key file: $f" >&2; exit 1; }
done

RUNNER="examples/claude-muse/dist/pilot-run.js"
if [ ! -f "$RUNNER" ]; then
  echo "building the pilot runner..." >&2
  pnpm --filter @agentbridge/example-claude-muse run build >&2
fi

exec node "$RUNNER"
