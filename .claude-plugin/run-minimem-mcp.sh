#!/bin/bash
# Wrapper script to run minimem MCP server
# Reads provider and directory from swarm config
# Exits silently if minimem is not enabled or not installed

# Check if minimem is enabled in config
ENABLED=false
if [ -f .swarm/claude-swarm/config.json ]; then
  ENABLED=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const envEnabled = (process.env.SWARM_MINIMEM_ENABLED || '').toLowerCase();
      const isEnabled = ['true', '1', 'yes'].includes(envEnabled) || c.minimem?.enabled === true;
      process.stdout.write(isEnabled ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")
elif [ -n "$SWARM_MINIMEM_ENABLED" ]; then
  case "$(echo "$SWARM_MINIMEM_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) ENABLED=true ;;
  esac
fi

if [ "$ENABLED" != "true" ]; then
  # Not enabled — exit silently so Claude Code doesn't show an error
  sleep 0.1
  exit 0
fi

# Read provider from config (defaults to "auto")
PROVIDER="auto"
if [ -f .swarm/claude-swarm/config.json ]; then
  CONFIGURED_PROVIDER=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const p = process.env.SWARM_MINIMEM_PROVIDER || c.minimem?.provider || '';
      if (p) process.stdout.write(p);
    } catch {}
  " 2>/dev/null)
  if [ -n "$CONFIGURED_PROVIDER" ]; then
    PROVIDER="$CONFIGURED_PROVIDER"
  fi
fi

if [ -n "$SWARM_MINIMEM_PROVIDER" ]; then
  PROVIDER="$SWARM_MINIMEM_PROVIDER"
fi

# Discover memory directory: config dir > .swarm/minimem/ > cwd
MEMORY_DIR=""
if [ -f .swarm/claude-swarm/config.json ]; then
  CONFIGURED_DIR=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const d = process.env.SWARM_MINIMEM_DIR || c.minimem?.dir || '';
      if (d) process.stdout.write(d);
    } catch {}
  " 2>/dev/null)
  if [ -n "$CONFIGURED_DIR" ]; then
    MEMORY_DIR="$CONFIGURED_DIR"
  fi
fi

if [ -n "$SWARM_MINIMEM_DIR" ]; then
  MEMORY_DIR="$SWARM_MINIMEM_DIR"
fi

if [ -z "$MEMORY_DIR" ]; then
  if [ -d ".swarm/minimem" ]; then
    MEMORY_DIR=".swarm/minimem"
  else
    MEMORY_DIR="."
  fi
fi

# Check if global memory should also be searched
GLOBAL_ARG=""
if [ -f .swarm/claude-swarm/config.json ]; then
  USE_GLOBAL=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('.swarm/claude-swarm/config.json', 'utf-8'));
      const envGlobal = (process.env.SWARM_MINIMEM_GLOBAL || '').toLowerCase();
      const isGlobal = ['true', '1', 'yes'].includes(envGlobal) || c.minimem?.global === true;
      process.stdout.write(isGlobal ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")
  if [ "$USE_GLOBAL" = "true" ]; then
    GLOBAL_ARG="--global"
  fi
fi

# Try installed minimem command
if command -v minimem &> /dev/null; then
  exec minimem mcp --dir "$MEMORY_DIR" --provider "$PROVIDER" $GLOBAL_ARG
fi

# minimem not installed — log to stderr and exit cleanly
echo "[minimem-mcp] minimem CLI not found. Install with: npm install -g minimem" >&2
exit 0
