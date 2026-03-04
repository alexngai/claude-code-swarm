---
name: swarm
description: Launch an agent team from an openteams topology template. Creates a native Claude Code team and spawns a coordinator agent.
user_invocable: true
argument: optional
---

# /swarm — Launch a Team Topology

You are the **swarm launcher** for the claude-code-swarm plugin. Your job is to launch a coordinated agent team from an openteams YAML topology template using Claude Code's native team features.

## What to do

Follow these steps in order. Be efficient — do not debug or retry failed commands, just proceed to the next step.

### Step 1: Find the plugin directory and generate artifacts

The plugin directory is listed in the system init message under `plugins` (look for `claude-code-swarm` and use its `path`). If you cannot find it there, run:

```bash
find ~/.claude/plugins -name "plugin.json" -path "*/claude-code-swarm/*" -exec dirname {} \; 2>/dev/null | head -1 | xargs dirname 2>/dev/null
```

The template name comes from `$ARGUMENTS` (e.g. `get-shit-done`). If none provided, ask the user. Templates available via openteams: **get-shit-done**, **bmad-method** (and more).

Generate artifacts with the team-loader script (this handles dependency resolution, artifact generation, and roles.json):

```bash
node "$PLUGIN_DIR/scripts/team-loader.mjs" "<template-name>"
```

### Step 2: Read the generated artifacts

1. Read `.swarm/claude-swarm/tmp/teams/<template-name>/SKILL.md` — the team catalog overview
2. Read `.swarm/claude-swarm/tmp/teams/<template-name>/agents/<root-role>.md` — the root agent's prompt (the root role is typically `orchestrator` for get-shit-done, `master` for bmad-method)

### Step 3: Create the native team

```
TeamCreate(
  team_name="<template-name>",
  description="<description from team-loader output>"
)
```

### Step 4: Spawn the coordinator agent

Build a coordinator prompt combining the root role's agent.md content, coordinator instructions, and the user's goal. Then spawn:

```
Agent(
  name="<root-role-name>",
  team_name="<template-name>",
  prompt="<coordinator prompt>"
)
```

The coordinator prompt should tell the agent to:
- Spawn companion agents (with `team_name`) by reading their `.swarm/claude-swarm/tmp/teams/<template-name>/agents/<role>.md`
- Create tasks via `TaskCreate` based on the user's goal
- Spawn additional agents on-demand per spawn_rules (always with `team_name`)
- Coordinate via `SendMessage` and track progress via `TaskList`/`TaskUpdate`

**Stop here.** The coordinator handles everything from this point.

## Important Notes

- **openteams is config-only** — used only for artifact generation, NOT for runtime coordination
- **Use Claude Code native teams** for all runtime: `TeamCreate`, `TaskCreate`, `TaskUpdate`, `SendMessage`
- All agents must be spawned with `team_name` so they share the team's task list
- If MAP is enabled in `.swarm/claude-swarm/config.json`, lifecycle events are handled automatically by hooks
