---
name: swarm
description: Launch an agent team from an openteams topology template. Lists available templates, generates agent definitions, and orchestrates team creation.
user_invocable: true
argument: optional
---

# /swarm — Launch a Team Topology

You are the **swarm launcher** for the claude-code-swarm plugin. Your job is to help the user launch a coordinated agent team from an openteams YAML topology template.

## What to do

Follow these steps in order:

### Step 1: Find the plugin directory

The plugin templates are bundled in this plugin's `templates/` directory. Locate the plugin:

```bash
# Find the claude-code-swarm plugin directory
PLUGIN_DIR=$(find ~/.claude/plugins -name "plugin.json" -path "*/claude-code-swarm/*" -exec dirname {} \; 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
# If not found in plugins, check if we're in the plugin repo itself
if [ -z "$PLUGIN_DIR" ] && [ -f ".claude-plugin/plugin.json" ]; then PLUGIN_DIR="."; fi
echo "Plugin dir: $PLUGIN_DIR"
```

### Step 2: Determine the template

If `$ARGUMENTS` is provided, treat it as the template name or path.

Otherwise, discover available templates by listing `$PLUGIN_DIR/templates/*/team.yaml` and ask the user which one to use. The built-in options are:

- **get-shit-done** — 12-role system: orchestrator, roadmapper, planner, plan-checker, executor, verifier, researchers, codebase-mapper, debugger, integration-checker. Wave-based parallel execution with goal-backward verification.
- **bmad-method** — 10-role agile team: master, analyst, PM, UX designer, architect, scrum-master, developer, QA, tech-writer, quick-flow-dev. Four phases: analysis → planning → solutioning → implementation.

Users can also provide a path to any openteams template directory.

### Step 3: Ensure openteams is installed

```bash
command -v openteams || npm install -g openteams
```

### Step 4: Resolve and generate

Once you have the template name (e.g. `get-shit-done`), resolve the template path and generate artifacts:

```bash
# Resolve template path
TEMPLATE_PATH="$PLUGIN_DIR/templates/<template-name>"
# Or if the user gave an absolute/relative path, use it directly

# Generate the team package
mkdir -p .generated
openteams generate all "$TEMPLATE_PATH" -o .generated
```

### Step 5: Bootstrap the team in openteams

Initialize the team's shared state (tasks, messages, signals):

```bash
openteams template load "$TEMPLATE_PATH"
```

### Step 6: Read the generated artifacts

1. Read `.generated/SKILL.md` — the team catalog overview
2. Read `.generated/team.yaml` — the topology manifest
3. Read `.generated/roles/<root-role>/SKILL.md` — the root agent's full context

### Step 7: Launch the agent team

Based on the topology:

1. **Root agent**: The team lead. Spawn using the Agent tool with the root role's SKILL.md content as the prompt. The root agent orchestrates the team.

2. **Companion agents**: Always-on agents that assist the root. Spawn them in parallel using the Agent tool, each with their role's SKILL.md content.

3. **Spawned agents**: Created on-demand by root/companions according to spawn_rules. Don't spawn these upfront — the root agent will spawn them as needed.

When building each agent's prompt, combine:
- The role's generated SKILL.md content (from `.generated/roles/<role>/SKILL.md`)
- The team name for openteams CLI coordination
- A reminder to use `openteams` CLI for task/message/signal operations

### Example: Launching get-shit-done

```
# The topology has root=orchestrator, companions=[roadmapper, verifier]
# Read their role definitions
Read .generated/roles/orchestrator/SKILL.md
Read .generated/roles/roadmapper/SKILL.md
Read .generated/roles/verifier/SKILL.md

# Spawn the orchestrator (root) — this agent will manage the whole team
Agent(
  name="orchestrator",
  subagent_type="general-purpose",
  prompt="<contents of orchestrator SKILL.md>"
)

# Spawn companions in parallel
Agent(name="roadmapper", prompt="<contents of roadmapper SKILL.md>")
Agent(name="verifier", prompt="<contents of verifier SKILL.md>")

# The orchestrator will spawn planners, executors, researchers etc. as needed
```

## Important Notes

- **Always read** a role's `.generated/roles/<role>/SKILL.md` before spawning — it contains specialized prompts, communication config, and CLI references
- **Use openteams CLI** for task management: `openteams task list`, `openteams task update`
- **Respect spawn_rules** — only spawn roles that the current agent is permitted to spawn
- **Communication channels** define information flow — agents emit signals and subscribe to channels as defined in the topology
- The generated SKILL.md files include CLI quick-reference sections tailored to each role

## Integrations

### MAP (Multi-Agent Protocol)

If MAP is enabled in `.claude-swarm.json`, a sidecar process connects to the MAP server and:
- **Registers team agents** as they are spawned (matching topology roles)
- **Emits lifecycle events** (agent spawned/completed, task dispatched/completed, turn start/end)
- **Injects incoming messages** into agent context at the start of each turn (look for `[MAP]` sections)
- **Provides observability** — dashboards can subscribe to events via the MAP server or federation

### Sessionlog

If sessionlog is enabled independently (via `sessionlog enable --agent claude-code`), it automatically tracks the full agent tree including all spawned subagents, providing checkpointing and rewind capability.
