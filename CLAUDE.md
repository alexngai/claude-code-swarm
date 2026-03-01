# claude-code-swarm

Claude Code plugin that launches agent teams from openteams YAML topologies, using Claude Code's native team features for coordination and optional MAP (Multi-Agent Protocol) for external observability.

## What this plugin does

This plugin bridges [openteams](https://github.com/alexngai/openteams) team templates with Claude Code's native agent teams. It provides:

1. **SessionStart hook** (`scripts/bootstrap.sh`) — Reads `.claude-swarm.json`, ensures openteams is installed, starts MAP sidecar if configured, and injects team context
2. **MAP integration** (`scripts/map-sidecar.mjs`, `scripts/map-hook.mjs`) — Persistent sidecar for external observability via MAP server (lifecycle events, agent registration)
3. **`/swarm` skill** (`skills/swarm/SKILL.md`) — User-invocable skill to select a template, create a native Claude Code team via `TeamCreate`, and spawn a coordinator agent
4. **Agent generator** (`scripts/generate-agents.mjs`) — Converts openteams YAML templates into Claude Code AGENT.md files with native team tool instructions
5. **Team loader** (`scripts/team-loader.sh`) — Resolves templates, generates artifacts, writes roles.json for MAP hook integration

## Plugin structure

```
claude-code-swarm/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/hooks.json              # Hook configuration (SessionStart, MAP hooks)
├── scripts/
│   ├── bootstrap.sh              # SessionStart: config, openteams, sidecar startup
│   ├── team-loader.sh            # Template resolution + artifact generation
│   ├── generate-agents.mjs       # Bridge: openteams templates → AGENT.md files
│   ├── map-sidecar.mjs           # Persistent MAP sidecar (WebSocket + UNIX socket)
│   └── map-hook.mjs              # Hook helper: inject, agent-spawning/completed, turn
├── skills/swarm/SKILL.md         # /swarm skill definition
├── templates/                    # Bundled team topology templates
│   ├── get-shit-done/            # GSD: wave-based parallel execution team
│   └── bmad-method/              # BMAD: full agile development team
├── settings.json                 # Enables agent teams, allows openteams/node commands
├── docs/
│   ├── design.md                 # Architecture design document
│   └── implementation-plan.md    # Implementation phases and pseudocode
└── .generated/                   # Generated artifacts (gitignored)
    └── map/                      # MAP runtime files (inbox, socket, pid, roles)
```

## How to use

### Quick start
1. Create `.claude-swarm.json` in your project root:
   ```json
   { "template": "get-shit-done" }
   ```
2. Start a Claude Code session — the hook loads the team automatically
3. Use `/swarm get-shit-done` to launch — this creates a native Claude Code team and spawns a coordinator

### How launching works

1. `/swarm` calls `openteams generate all` to produce role artifacts (SKILL.md per role)
2. `/swarm` calls `TeamCreate` to set up a native Claude Code team with shared task list
3. `/swarm` spawns a **coordinator agent** (the topology's root role) with `team_name`
4. The coordinator reads the topology and spawns companions/workers (all with `team_name`)
5. Agents coordinate via **SendMessage** and track work via **TaskCreate/TaskUpdate/TaskList**

### With MAP observability
```json
{
  "template": "get-shit-done",
  "map": {
    "enabled": true,
    "server": "ws://localhost:8080",
    "sidecar": "session"
  }
}
```

MAP options:
- `server` — MAP server WebSocket URL (default: `ws://localhost:8080`)
- `scope` — MAP scope name (default: `swarm:<template>`)
- `systemId` — System identifier for federation (default: `system-claude-swarm`)
- `sidecar` — `"session"` (starts/stops with session) or `"persistent"` (user-managed)

### Available templates
- **get-shit-done** — 12-role system with wave-based parallel execution, goal-backward verification
- **bmad-method** — 10-role agile team across 4 phases (analysis, planning, solutioning, implementation)

### Custom templates
Point to any openteams template directory:
```json
{ "template": "/path/to/your/template" }
```

## Architecture

### Team launch flow

1. **SessionStart** → `bootstrap.sh`: reads config, installs openteams, starts MAP sidecar, outputs context
2. **`/swarm`** → generates artifacts via `openteams generate all`, calls `TeamCreate`, spawns coordinator agent with `team_name`
3. **Coordinator** → reads topology, spawns companions/workers (all with `team_name`), creates tasks via `TaskCreate`, coordinates via `SendMessage`

### Runtime coordination

All agent coordination uses Claude Code's native team features:
- **TeamCreate** — sets up the team with shared task list
- **TaskCreate/TaskUpdate/TaskList** — task lifecycle (create, claim, progress, complete)
- **SendMessage** — agent-to-agent communication (direct messages, broadcasts)
- **Agent tool with `team_name`** — spawns agents as team members

openteams is used **only for configuration** — topology definitions, role prompts, and artifact generation (`openteams generate all`). It has no runtime role.

### MAP hooks (external observability)

1. **UserPromptSubmit** → `map-hook.mjs inject`: reads MAP inbox, injects external messages into context
2. **PreToolUse(Task)** → `map-hook.mjs agent-spawning`: registers team agents in MAP, emits spawn events
3. **PostToolUse(Task)** → `map-hook.mjs agent-completed`: unregisters agents, emits completion events
4. **Stop** → `map-hook.mjs turn-completed`: updates sidecar state, emits turn events

### MAP sidecar

The sidecar (`map-sidecar.mjs`) is a persistent Node.js process that:
- Connects to the MAP server via WebSocket with auto-reconnection
- Listens on a UNIX socket (`.generated/map/sidecar.sock`) for commands from hooks
- Writes incoming external MAP messages to `.generated/map/inbox.jsonl`
- Manages team agent registrations (register/unregister on spawn/complete)
- Self-terminates after 30 minutes of inactivity (session mode)

The hook helper (`map-hook.mjs`) includes best-effort auto-recovery: if the sidecar is down, it attempts to restart it, with a fire-and-forget direct WebSocket fallback if recovery fails.

### Agent registration

Only topology-defined roles (from `team.yaml`) get MAP agent registrations. Internal subagents spawned by the Agent tool do not. Role matching is done via `.generated/map/roles.json` written during team loading.

## Key dependencies
- **openteams** (npm package) — installed automatically by the SessionStart hook; used for artifact generation only
- **@multi-agent-protocol/sdk** (npm package) — installed automatically when MAP is enabled
- **Claude Code agent teams** — enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json

## Development notes
- Templates in `templates/` are copied from openteams' `examples/` directory
- The generate-agents script has a fallback mode when openteams isn't installed (basic YAML parsing)
- Generated artifacts go in `.generated/` which should be gitignored
- openteams is config/generation only — Claude Code native teams handle all runtime coordination, MAP handles external observability
- See `docs/design.md` for detailed architecture decisions and `docs/implementation-plan.md` for phase breakdown
