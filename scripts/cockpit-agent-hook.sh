#!/bin/sh
# Observation-only Claude/Codex hook. It never prints a decision, so native
# approval policy and other hooks (including Orca) remain authoritative.
payload=$(cat)
[ -z "$payload" ] && exit 0

if command -v jq >/dev/null 2>&1; then
  payload=$(printf '%s' "$payload" | jq -c --arg kind "${1:-unknown}" --arg term "${COCKPIT_TERM_ID:-}" \
    '. + {agent_kind:$kind} + (if $term == "" then {} else {term_id:$term} end)' 2>/dev/null) || exit 0
fi

curl -sS --connect-timeout 0.5 --max-time 2 \
  -H 'Content-Type: application/json' --data-binary "$payload" \
  "http://127.0.0.1:${COCKPIT_PORT:-3847}/api/supervisor/event" >/dev/null 2>&1 || true
exit 0
