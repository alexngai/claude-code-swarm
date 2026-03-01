#!/usr/bin/env bash
# bootstrap.sh — SessionStart hook for claude-code-swarm
#
# Reads .claude-swarm.json, checks integrations, starts MAP sidecar if configured.
# Output goes to stdout → injected into Claude's context.
# Errors go to stderr → logged but not shown to Claude.
# Exit 0 always — never block the session.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE=".claude-swarm.json"

# ── 1. Read config ───────────────────────────────────────────────────────────

TMPL=""
MAP_ENABLED="false"
MAP_SERVER="ws://localhost:8080"
MAP_SCOPE=""
MAP_SYSTEM_ID="system-claude-swarm"
MAP_SIDECAR="session"
SESSIONLOG_ENABLED="false"

if [ -f "$CONFIG_FILE" ]; then
  eval "$(node -e "
    const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
    const q = s => \"'\" + s.replace(/'/g, \"'\\\\''\" ) + \"'\";
    console.log('TMPL=' + q(c.template || ''));
    console.log('MAP_ENABLED=' + q(String(c.map?.enabled || false)));
    console.log('MAP_SERVER=' + q(c.map?.server || 'ws://localhost:8080'));
    console.log('MAP_SCOPE=' + q(c.map?.scope || ''));
    console.log('MAP_SYSTEM_ID=' + q(c.map?.systemId || 'system-claude-swarm'));
    console.log('MAP_SIDECAR=' + q(c.map?.sidecar || 'session'));
    console.log('SESSIONLOG_ENABLED=' + q(String(c.sessionlog?.enabled || false)));
  " 2>/dev/null)" || true
fi

# Auto-derive scope from template name if not set
if [ -n "$TMPL" ] && [ -z "$MAP_SCOPE" ]; then
  MAP_SCOPE="swarm:$TMPL"
fi

# ── 2. Ensure openteams is available ─────────────────────────────────────────

if ! command -v openteams &>/dev/null; then
  echo "Installing openteams..." >&2
  npm install -g openteams 2>&1 >&2 || true
fi

# ── 3. Check sessionlog status ───────────────────────────────────────────────

SESSIONLOG_STATUS="not installed"
if command -v sessionlog &>/dev/null; then
  if sessionlog status 2>/dev/null | grep -q "enabled.*true" 2>/dev/null; then
    SESSIONLOG_STATUS="active"
  else
    SESSIONLOG_STATUS="installed but not enabled"
  fi
fi

# ── 4. Start MAP sidecar if configured ───────────────────────────────────────

MAP_STATUS="disabled"
if [ "$MAP_ENABLED" = "true" ]; then
  # Ensure MAP SDK is available
  if ! node -e "require('@multi-agent-protocol/sdk')" 2>/dev/null; then
    echo "Installing @multi-agent-protocol/sdk..." >&2
    npm install -g @multi-agent-protocol/sdk 2>&1 >&2 || true
  fi

  mkdir -p .generated/map

  if [ "$MAP_SIDECAR" = "session" ]; then
    # Kill any existing sidecar from a previous session
    if [ -f .generated/map/sidecar.pid ]; then
      OLD_PID=$(cat .generated/map/sidecar.pid 2>/dev/null || echo "")
      if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.5
      fi
      rm -f .generated/map/sidecar.pid
    fi
    rm -f .generated/map/sidecar.sock

    # Start sidecar as background process
    nohup node "$PLUGIN_DIR/scripts/map-sidecar.mjs" \
      --server "$MAP_SERVER" \
      --scope "$MAP_SCOPE" \
      --system-id "$MAP_SYSTEM_ID" \
      >> .generated/map/sidecar.log 2>&1 &
    SIDECAR_PID=$!
    echo "$SIDECAR_PID" > .generated/map/sidecar.pid

    # Wait briefly for socket to appear
    for i in 1 2 3 4 5; do
      if [ -S .generated/map/sidecar.sock ]; then
        break
      fi
      sleep 0.5
    done

    if [ -S .generated/map/sidecar.sock ]; then
      MAP_STATUS="connected (scope: $MAP_SCOPE)"
    else
      MAP_STATUS="starting (scope: $MAP_SCOPE)"
    fi

  elif [ "$MAP_SIDECAR" = "persistent" ]; then
    if [ -S .generated/map/sidecar.sock ]; then
      MAP_STATUS="connected via persistent sidecar (scope: $MAP_SCOPE)"
    else
      MAP_STATUS="WARNING: persistent sidecar not running at .generated/map/sidecar.sock"
    fi
  fi
fi

# ── 5. Output context ────────────────────────────────────────────────────────

echo "## Claude Code Swarm (openteams)"
echo ""

if [ -n "$TMPL" ]; then
  echo "Team template configured: **$TMPL**"
else
  echo "No team template configured."
fi

if [ "$MAP_ENABLED" = "true" ]; then
  echo "MAP: $MAP_STATUS"
fi

if [ "$SESSIONLOG_ENABLED" = "true" ]; then
  if [ "$SESSIONLOG_STATUS" = "active" ]; then
    echo "Sessionlog: active"
  else
    echo "Sessionlog: WARNING — configured but $SESSIONLOG_STATUS"
  fi
fi

echo ""
echo "Use \`/swarm\` to launch the team, or \`/swarm <template>\` for a specific template."
echo "Built-in templates: **get-shit-done**, **bmad-method**"
