#!/bin/bash
# Wrapper script to run opentasks MCP server
# Reads scope from swarm config, defaults to "tasks"
# Exits silently if opentasks is not enabled or not installed

# Check if opentasks is enabled in config
ENABLED=false
if [ -f .swarm/claude-swarm/config.json ]; then
  ENABLED=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const envEnabled = (process.env.SWARM_OPENTASKS_ENABLED || '').toLowerCase();
      const isEnabled = ['true', '1', 'yes'].includes(envEnabled) || c.opentasks?.enabled === true;
      process.stdout.write(isEnabled ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")
elif [ -n "$SWARM_OPENTASKS_ENABLED" ]; then
  case "$(echo "$SWARM_OPENTASKS_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) ENABLED=true ;;
  esac
fi

if [ "$ENABLED" != "true" ]; then
  # Not enabled — exit silently so Claude Code doesn't show an error
  # Sleep briefly then exit so the MCP transport doesn't see an immediate close
  sleep 0.1
  exit 0
fi

# Read scope from config
SCOPE="tasks"
if [ -f .swarm/claude-swarm/config.json ]; then
  CONFIGURED_SCOPE=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const s = c.opentasks?.scope || process.env.SWARM_OPENTASKS_SCOPE || '';
      if (s) process.stdout.write(s);
    } catch {}
  " 2>/dev/null)
  if [ -n "$CONFIGURED_SCOPE" ]; then
    SCOPE="$CONFIGURED_SCOPE"
  fi
fi

if [ -n "$SWARM_OPENTASKS_SCOPE" ]; then
  SCOPE="$SWARM_OPENTASKS_SCOPE"
fi

# Build socket path arg if daemon socket exists
SOCKET_ARG=""
for SOCK in .swarm/opentasks/daemon.sock .opentasks/daemon.sock .git/opentasks/daemon.sock; do
  if [ -S "$SOCK" ]; then
    SOCKET_ARG="--socket $SOCK"
    break
  fi
done

# Try installed opentasks command
if command -v opentasks &> /dev/null; then
  exec opentasks mcp --scope "$SCOPE" $SOCKET_ARG
fi

# opentasks not installed — log to stderr and exit cleanly
echo "[opentasks-mcp] opentasks CLI not found. Install with: npm install -g opentasks" >&2
exit 0
