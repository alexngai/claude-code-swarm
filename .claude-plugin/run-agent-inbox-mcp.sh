#!/bin/bash
# Wrapper script to run agent-inbox MCP server
# When the sidecar's inbox socket exists, runs in proxy mode (IPC client).
# Otherwise falls back to standalone mode with its own storage.
# Exits silently if inbox is not enabled or not installed.

# Check if inbox is enabled in config
ENABLED=false
if [ -f .swarm/claude-swarm/config.json ]; then
  ENABLED=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const envEnabled = (process.env.SWARM_INBOX_ENABLED || '').toLowerCase();
      const isEnabled = ['true', '1', 'yes'].includes(envEnabled) || c.inbox?.enabled === true;
      process.stdout.write(isEnabled ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")
elif [ -n "$SWARM_INBOX_ENABLED" ]; then
  case "$(echo "$SWARM_INBOX_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) ENABLED=true ;;
  esac
fi

if [ "$ENABLED" != "true" ]; then
  # Not enabled — exit silently so Claude Code doesn't show an error
  sleep 0.1
  exit 0
fi

# Read scope from config (defaults to MAP scope or "default")
SCOPE="default"
if [ -f .swarm/claude-swarm/config.json ]; then
  CONFIGURED_SCOPE=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const s = c.inbox?.scope || c.map?.scope || process.env.SWARM_INBOX_SCOPE || '';
      if (s) process.stdout.write(s);
    } catch {}
  " 2>/dev/null)
  if [ -n "$CONFIGURED_SCOPE" ]; then
    SCOPE="$CONFIGURED_SCOPE"
  fi
fi

if [ -n "$SWARM_INBOX_SCOPE" ]; then
  SCOPE="$SWARM_INBOX_SCOPE"
fi

export INBOX_SCOPE="$SCOPE"

# Discover sidecar inbox socket for proxy mode
# Check well-known paths: .swarm/claude-swarm/tmp/map/inbox.sock
INBOX_SOCK=""
if [ -S .swarm/claude-swarm/tmp/map/inbox.sock ]; then
  INBOX_SOCK=".swarm/claude-swarm/tmp/map/inbox.sock"
fi

# Also check per-session paths
if [ -z "$INBOX_SOCK" ] && [ -d .swarm/claude-swarm/tmp/map/sessions ]; then
  # Find the most recently modified inbox.sock in session dirs
  INBOX_SOCK=$(find .swarm/claude-swarm/tmp/map/sessions -name inbox.sock -type s 2>/dev/null | head -1)
fi

# If inbox socket found, enable proxy mode
if [ -n "$INBOX_SOCK" ]; then
  export INBOX_SOCKET_PATH="$INBOX_SOCK"
fi

# Try to find the agent-inbox module entry point
INBOX_MAIN=""

# 1. Check global npm root (swarmkit installs here)
GLOBAL_ROOT=$(npm root -g 2>/dev/null)
if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_ROOT/agent-inbox/dist/index.js" ]; then
  INBOX_MAIN="$GLOBAL_ROOT/agent-inbox/dist/index.js"
fi

# 2. Check plugin directory's node_modules (dev installs)
if [ -z "$INBOX_MAIN" ] && [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/node_modules/agent-inbox/dist/index.js" ]; then
  INBOX_MAIN="$CLAUDE_PLUGIN_ROOT/node_modules/agent-inbox/dist/index.js"
fi

# 3. Fallback: try require.resolve from CWD
if [ -z "$INBOX_MAIN" ]; then
  INBOX_MAIN=$(node -e "try { console.log(require.resolve('agent-inbox/dist/index.js')); } catch {}" 2>/dev/null)
fi

if [ -n "$INBOX_MAIN" ]; then
  # Uses proxy mode when INBOX_SOCKET_PATH is set, standalone otherwise
  exec node "$INBOX_MAIN" mcp
fi

# agent-inbox not installed — log to stderr and exit cleanly
echo "[agent-inbox-mcp] agent-inbox not found. Install with: npm install -g agent-inbox or install via swarmkit" >&2
exit 0
