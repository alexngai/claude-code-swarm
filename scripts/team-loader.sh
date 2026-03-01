#!/usr/bin/env bash
# team-loader.sh — Team loading script for claude-code-swarm
#
# Called by the /swarm skill or manually. It:
# 1. Ensures the openteams CLI is installed
# 2. Resolves the team template path
# 3. Generates agent definitions using openteams
# 4. Outputs team context for the session
#
# Usage: team-loader.sh [template-name-or-path] [plugin-dir]

set -euo pipefail

# Accept template name as argument (for /swarm skill invocation)
ARG_TEMPLATE="${1:-}"
ARG_PLUGIN_DIR="${2:-}"

# Determine plugin directory
if [ -n "$ARG_PLUGIN_DIR" ]; then
  PLUGIN_DIR="$ARG_PLUGIN_DIR"
elif [ -n "${CLAUDE_CODE_SWARM_DIR:-}" ]; then
  PLUGIN_DIR="$CLAUDE_CODE_SWARM_DIR"
else
  PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi

GENERATED_DIR="${PLUGIN_DIR}/.generated"

# ── 1. Ensure openteams is available ──────────────────────────────────────────

if ! command -v openteams &>/dev/null; then
  echo "## openteams not found — installing..." >&2
  npm install -g openteams 2>&1 >&2
  if ! command -v openteams &>/dev/null; then
    echo "ERROR: Failed to install openteams. Install manually: npm install -g openteams" >&2
    exit 0  # Don't block session start
  fi
fi

# ── 2. Determine which team template to use ───────────────────────────────────

# Determine template: argument > .claude-swarm.json > plugin settings
TEAM_TEMPLATE=""

# Priority 1: command-line argument
if [ -n "$ARG_TEMPLATE" ]; then
  TEAM_TEMPLATE="$ARG_TEMPLATE"
fi

# Priority 2: .claude-swarm.json in the project root (cwd)
if [ -z "$TEAM_TEMPLATE" ] && [ -f ".claude-swarm.json" ]; then
  TEAM_TEMPLATE=$(node -e "
    const cfg = JSON.parse(require('fs').readFileSync('.claude-swarm.json', 'utf-8'));
    console.log(cfg.template || '');
  " 2>/dev/null || echo "")
fi

# Priority 3: plugin settings
if [ -z "$TEAM_TEMPLATE" ] && [ -f "$PLUGIN_DIR/settings.json" ]; then
  TEAM_TEMPLATE=$(node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/settings.json', 'utf-8'));
    console.log(cfg.defaultTemplate || '');
  " 2>/dev/null || echo "")
fi

# If no template configured, output available templates and exit
if [ -z "$TEAM_TEMPLATE" ]; then
  echo "## Claude Code Swarm"
  echo ""
  echo "No team template configured. Use \`/swarm\` to launch a team, or create a \`.claude-swarm.json\` in your project:"
  echo ""
  echo '```json'
  echo '{'
  echo '  "template": "get-shit-done"'
  echo '}'
  echo '```'
  echo ""
  echo "Available built-in templates:"
  for dir in "$PLUGIN_DIR/templates"/*/; do
    if [ -f "$dir/team.yaml" ]; then
      name=$(basename "$dir")
      desc=$(node -e "
        const yaml = require('js-yaml');
        const fs = require('fs');
        const m = yaml.load(fs.readFileSync('$dir/team.yaml', 'utf-8'));
        console.log(m.description || 'No description');
      " 2>/dev/null || echo "No description")
      echo "  - **$name**: $desc"
    fi
  done
  exit 0
fi

# ── 3. Resolve template path ─────────────────────────────────────────────────

TEMPLATE_PATH=""

# If it's an absolute or relative path that exists, use it directly
if [ -d "$TEAM_TEMPLATE" ]; then
  TEMPLATE_PATH="$TEAM_TEMPLATE"
# Check built-in templates
elif [ -d "$PLUGIN_DIR/templates/$TEAM_TEMPLATE" ]; then
  TEMPLATE_PATH="$PLUGIN_DIR/templates/$TEAM_TEMPLATE"
# Check if openteams has it installed
elif command -v openteams &>/dev/null; then
  # Try openteams template registry
  INSTALLED_PATH=$(openteams template list --json 2>/dev/null | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    const t = data.find(t => t.name === '$TEAM_TEMPLATE');
    console.log(t ? t.path : '');
  " 2>/dev/null || echo "")
  if [ -n "$INSTALLED_PATH" ] && [ -d "$INSTALLED_PATH" ]; then
    TEMPLATE_PATH="$INSTALLED_PATH"
  fi
fi

if [ -z "$TEMPLATE_PATH" ]; then
  echo "## Claude Code Swarm"
  echo ""
  echo "WARNING: Team template '$TEAM_TEMPLATE' not found."
  echo "Use \`/swarm\` to list and select an available template."
  exit 0
fi

# ── 4. Generate agent definitions ─────────────────────────────────────────────

mkdir -p "$GENERATED_DIR"

# Use openteams to generate the package
openteams generate all "$TEMPLATE_PATH" -o "$GENERATED_DIR" 2>&1 >&2 || {
  echo "## Claude Code Swarm"
  echo ""
  echo "WARNING: Failed to generate team artifacts from $TEMPLATE_PATH"
  echo "Run \`openteams generate all $TEMPLATE_PATH -o $GENERATED_DIR\` manually to debug."
  exit 0
}

# ── 5. Output team context for the session ────────────────────────────────────

echo "## Claude Code Swarm — Team Loaded"
echo ""

# Output the catalog (lightweight team overview)
if [ -f "$GENERATED_DIR/SKILL.md" ]; then
  cat "$GENERATED_DIR/SKILL.md"
fi

echo ""
echo "---"
echo ""
echo "### Agent Team Instructions"
echo ""
echo "A team topology has been loaded from \`$TEMPLATE_PATH\`. To launch this team:"
echo ""
echo "1. **Enable agent teams**: Ensure \`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\` is set"
echo "2. **Spawn teammates** according to the topology above using the Agent tool"
echo "3. **Use openteams CLI** for shared state (tasks, messages, signals) between agents"
echo ""
echo "Per-role prompts are available at \`$GENERATED_DIR/roles/<role>/SKILL.md\`"
echo "Read a role's SKILL.md before spawning an agent for that role."
echo ""
TEAM_NAME=$(node -e "
  const yaml = require('js-yaml');
  const fs = require('fs');
  const m = yaml.load(fs.readFileSync('$TEMPLATE_PATH/team.yaml', 'utf-8'));
  console.log(m.name);
" 2>/dev/null || basename "$TEMPLATE_PATH")

# ── 6. Write roles.json for MAP hook integration ────────────────────────────

node -e "
  try {
    const yaml = require('js-yaml');
    const fs = require('fs');
    const m = yaml.load(fs.readFileSync('$TEMPLATE_PATH/team.yaml', 'utf-8'));
    const roles = {
      team: m.name || '',
      roles: m.roles || [],
      root: m.topology?.root?.role || '',
      companions: (m.topology?.companions || []).map(c => c.role || c)
    };
    fs.mkdirSync('.generated/map', { recursive: true });
    fs.writeFileSync('.generated/map/roles.json', JSON.stringify(roles, null, 2));
  } catch (e) {
    process.stderr.write('Warning: could not write roles.json: ' + e.message + '\n');
  }
" 2>/dev/null || true

# ── 7. Output coordination instructions ─────────────────────────────────────

echo "To coordinate via openteams shared state:"
echo '```bash'
echo "openteams task list $TEAM_NAME"
echo "openteams task update $TEAM_NAME <id> --status completed"
echo '```'
echo ""
echo "**MAP:** Messages from teammates are automatically injected into your context."
echo "Check for **[MAP]** sections at the start of each turn."
