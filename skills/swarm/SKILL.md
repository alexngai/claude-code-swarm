---
name: swarm
description: Launch an agent team from an openteams topology template. Creates a native Claude Code team and spawns a coordinator agent.
user_invocable: true
argument: optional
---

# /swarm — Launch a Team Topology

You are the **swarm launcher** for the claude-code-swarm plugin. Your job is to help the user launch a coordinated agent team from an openteams YAML topology template using Claude Code's native team features.

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

### Step 5: Read the generated artifacts

1. Read `.generated/SKILL.md` — the team catalog overview
2. Read `.generated/team.yaml` — the topology manifest (extract team `name`, `description`, `topology.root.role`, `topology.companions`, `spawn_rules`, and `communication` sections)
3. Read `.generated/roles/<root-role>/SKILL.md` — the root agent's full context

### Step 6: Create the native team

Extract the team name and description from the topology manifest, then create the Claude Code team:

```
TeamCreate(
  team_name="<team-name-from-yaml>",
  description="<team-description-from-yaml>"
)
```

### Step 7: Spawn the coordinator agent

Build a coordinator prompt and spawn the root agent as a team member. The coordinator prompt should combine:

1. **The root role's SKILL.md content** — their specialized instructions
2. **Coordinator setup instructions** — telling the agent to:
   - Spawn companion agents (with `team_name`) by reading their SKILL.md from `.generated/roles/<role>/SKILL.md`
   - Create tasks via `TaskCreate` based on the user's goal
   - Spawn additional agents on-demand per `spawn_rules` (always with `team_name`)
   - Coordinate via `SendMessage` and track progress via `TaskList`/`TaskUpdate`
3. **Topology summary** — the roles, spawn_rules, and communication patterns from the manifest
4. **The user's original goal/request**

Spawn the coordinator:

```
Agent(
  name="<root-role-name>",
  team_name="<team-name>",
  prompt="<coordinator prompt assembled above>"
)
```

**Stop here.** The coordinator handles everything from this point — spawning companions, creating tasks, spawning workers, and managing the workflow.

### Example: Launching get-shit-done

```
# Read the topology and root role definition
Read .generated/team.yaml
Read .generated/roles/orchestrator/SKILL.md

# Create the native Claude Code team
TeamCreate(
  team_name="get-shit-done",
  description="Wave-based parallel execution with goal-backward verification"
)

# Spawn the coordinator (root agent) as a team member
Agent(
  name="orchestrator",
  team_name="get-shit-done",
  prompt="<orchestrator SKILL.md + coordinator instructions + topology summary + user goal>"
)

# The orchestrator will:
# - Spawn roadmapper, verifier as companions (with team_name="get-shit-done")
# - Create tasks via TaskCreate for the user's goal
# - Spawn planners, executors, researchers on-demand (with team_name)
# - Coordinate via SendMessage, track via TaskList/TaskUpdate
```

## Important Notes

- **Always read** a role's `.generated/roles/<role>/SKILL.md` before including it in the coordinator prompt or spawning an agent
- **openteams is config-only** — used for `openteams generate all` to produce role artifacts, NOT for runtime task/message/signal management
- **Use Claude Code native teams** for all runtime coordination: `TeamCreate`, `TaskCreate`, `TaskUpdate`, `SendMessage`
- **Respect spawn_rules** from the topology — only spawn roles that the current agent is permitted to spawn
- **Communication patterns** from the topology define information flow — embed them in agent prompts as SendMessage guidance
- All agents must be spawned with `team_name` so they share the team's task list and can message each other

## Integrations

### MAP (Multi-Agent Protocol)

If MAP is enabled in `.claude-swarm.json`, a sidecar process connects to the MAP server and:
- **Registers team agents** as they are spawned (matching topology roles)
- **Emits lifecycle events** (agent spawned/completed, task dispatched/completed, turn start/end)
- **Injects external messages** into agent context at the start of each turn (look for `[MAP]` sections — these are from external systems, not teammates)
- **Provides observability** — dashboards can subscribe to events via the MAP server or federation

Agents do not interact with MAP directly — it is handled automatically by hooks.

### Sessionlog

If sessionlog is enabled independently (via `sessionlog enable --agent claude-code`), it automatically tracks the full agent tree including all spawned subagents, providing checkpointing and rewind capability.
