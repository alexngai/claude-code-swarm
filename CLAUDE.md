# claude-code-swarm

Claude Code plugin that launches agent teams from openteams YAML topologies, using Claude Code's native team features for coordination and optional MAP (Multi-Agent Protocol) for external observability.

## What this plugin does

This plugin bridges [openteams](https://github.com/alexngai/openteams) team templates with Claude Code's native agent teams. It provides:

1. **SessionStart hook** (`scripts/bootstrap.mjs`) — Reads `.claude-swarm.json`, installs deps, starts MAP sidecar if configured, and injects team context
2. **MAP integration** (`scripts/map-sidecar.mjs`, `scripts/map-hook.mjs`) — Persistent sidecar for external observability via MAP server (lifecycle events, agent registration)
3. **`/swarm` skill** (`skills/swarm/SKILL.md`) — User-invocable skill to select a template, create a native Claude Code team via `TeamCreate`, and spawn a coordinator agent
4. **Agent generator** (`scripts/generate-agents.mjs`) — Converts openteams YAML templates into Claude Code AGENT.md files with native team tool instructions
5. **Team loader** (`scripts/team-loader.mjs`) — Resolves templates, generates artifacts, writes roles.json for MAP hook integration

## Plugin structure

```
claude-code-swarm/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/hooks.json              # Hook configuration (SessionStart, MAP hooks)
├── package.json                  # type:module, exports, bin, deps
├── src/                          # Core logic modules
│   ├── index.mjs                 # Barrel re-export of public API
│   ├── config.mjs                # Config parsing + defaults
│   ├── paths.mjs                 # Path constants + ensureMapDir
│   ├── roles.mjs                 # Role reading, matching, writing roles.json
│   ├── inbox.mjs                 # Inbox read/clear/format/write
│   ├── map-connection.mjs        # MAP SDK connection + fire-and-forget
│   ├── sidecar-client.mjs        # UNIX socket client + recovery
│   ├── sidecar-server.mjs        # UNIX socket server + command handler
│   ├── map-events.mjs            # Event builders + emit (sidecar → fallback)
│   ├── sessionlog.mjs            # Session detection, trajectory checkpoints, sync
│   ├── template.mjs              # Template resolution + openteams generation
│   ├── agent-generator.mjs       # AGENT.md generation (tools, frontmatter)
│   ├── context-output.mjs        # Markdown formatting for hook stdout
│   └── bootstrap.mjs             # SessionStart orchestration
├── scripts/                      # Thin CLI wrappers (invoked by hooks)
│   ├── bootstrap.mjs             # SessionStart → src/bootstrap + src/context-output
│   ├── map-sidecar.mjs           # Persistent sidecar → src/map-connection + src/sidecar-server
│   ├── map-hook.mjs              # Hook helper → dispatches to src/ modules
│   ├── team-loader.mjs           # Template loading → src/template + src/roles
│   └── generate-agents.mjs       # AGENT.md generation → src/agent-generator
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

### With sessionlog → MAP sync
```json
{
  "template": "get-shit-done",
  "map": { "enabled": true },
  "sessionlog": {
    "enabled": true,
    "sync": "full"
  }
}
```

When both MAP and sessionlog are active, the plugin bridges sessionlog's session data into MAP using the **Trajectory Protocol** (`trajectory/checkpoint`). Each sync emits a queryable `TrajectoryCheckpoint` with structured metadata. If the MAP server doesn't support the trajectory protocol, the bridge falls back to sending a `trajectory.checkpoint` message payload. Sync levels control what goes into checkpoint metadata:
- `"off"` — no bridge (default)
- `"lifecycle"` — session/turn identifiers and phase only
- `"metrics"` — above + token usage, files touched, step count, checkpoint IDs
- `"full"` — complete SessionState snapshot

Requires sessionlog to be installed and active independently (`sessionlog enable`).

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

1. **SessionStart** → `scripts/bootstrap.mjs`: reads config, installs deps, starts MAP sidecar, outputs context
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

All hooks use MAP SDK primitives — no custom `swarm.*` event types. Clients subscribe to standard MAP events only:
- `agent_registered` / `agent_unregistered` / `agent_state_changed` for agent lifecycle
- `message_sent` for task lifecycle (typed payloads like `{ type: "task.dispatched", ... }`)
- `trajectory.checkpoint` for sessionlog sync

Hook dispatch:
1. **UserPromptSubmit** → `map-hook.mjs inject`: reads MAP inbox, injects external messages into context
2. **PreToolUse(Task)** → `map-hook.mjs agent-spawning`: spawns agent via `conn.spawn()` (server auto-emits `agent_registered`), sends `task.dispatched` message
3. **PostToolUse(Task)** → `map-hook.mjs agent-completed`: marks agent done via `conn.callExtension("map/agents/unregister")` (server auto-emits `agent_unregistered`), sends `task.completed` message
4. **Stop** → `map-hook.mjs turn-completed`: updates sidecar state via `conn.updateState("idle")` (server auto-emits `agent_state_changed`)
5. **Stop** → `map-hook.mjs sessionlog-sync`: reads sessionlog state, reports `trajectory/checkpoint` to MAP (falls back to `trajectory.checkpoint` message payload if server doesn't support trajectory)
6. **SubagentStart** → `map-hook.mjs subagent-start`: spawns subagent via `conn.spawn()` with `role: "subagent"`
7. **SubagentStop** → `map-hook.mjs subagent-stop`: marks subagent done
8. **TeammateIdle** → `map-hook.mjs teammate-idle`: updates teammate state to idle
9. **TaskCompleted** → `map-hook.mjs task-completed`: sends `task.completed` message

### MAP sidecar

The sidecar (`scripts/map-sidecar.mjs`) is a persistent Node.js process that:
- Connects to the MAP server via WebSocket with auto-reconnection
- Listens on a UNIX socket (`.generated/map/sidecar.sock`) for commands from hooks
- Writes incoming external MAP messages to `.generated/map/inbox.jsonl`
- Manages agent lifecycle via SDK primitives: `conn.spawn()` for registration, `conn.callExtension("map/agents/unregister")` for deregistration, `conn.updateState()` for state changes
- Sends task lifecycle as typed message payloads via `conn.send()`
- Reports trajectory checkpoints via `trajectory/checkpoint` (with `trajectory.checkpoint` message fallback)
- Self-terminates after 30 minutes of inactivity (session mode)

The hook helper (`scripts/map-hook.mjs`) includes best-effort auto-recovery: if the sidecar is down, it attempts to restart it, with a fire-and-forget direct WebSocket fallback if recovery fails.

### Agent registration

Only topology-defined roles (from `team.yaml`) get full MAP agent registrations via `conn.spawn()`. Subagents are also spawned in MAP with `role: "subagent"` for observability. Role matching is done via `.generated/map/roles.json` written during team loading. All agent context (role, template, agentType, isTeamRole) goes into agent `metadata`.

### Module architecture

All logic lives in `src/` as importable ES modules. Scripts in `scripts/` are thin CLI wrappers (~20-30 lines each) that parse args, call `src/` functions, and handle stdout/stderr.

```
src/config.mjs          ← readConfig(), resolveScope(), resolveTeamName()
src/paths.mjs            ← SOCKET_PATH, INBOX_PATH, PID_PATH, etc.
src/roles.mjs            ← readRoles(), matchRole(), writeRoles()
src/inbox.mjs            ← readInbox(), clearInbox(), formatInboxAsMarkdown()
src/map-connection.mjs   ← connectToMAP(), fireAndForget(), fireAndForgetTrajectory()
src/sidecar-client.mjs   ← sendToSidecar(), ensureSidecar(), startSidecar()
src/sidecar-server.mjs   ← createSocketServer(), createCommandHandler()
src/map-events.mjs       ← sendCommand(), emitPayload(), build*Command(), build*Payload()
src/sessionlog.mjs       ← findActiveSession(), buildTrajectoryCheckpoint(), syncSessionlog()
src/template.mjs         ← resolveTemplatePath(), generateTeamArtifacts()
src/agent-generator.mjs  ← generateAllAgents(), generateAgentMd()
src/context-output.mjs   ← format*Context(), format*Message()
src/bootstrap.mjs        ← bootstrap() — full SessionStart orchestration
src/index.mjs            ← barrel re-export of public API
```

## Key dependencies

Declared in `package.json` and installed automatically by the SessionStart hook (`npm install --production` in the plugin directory):
- **openteams** — team topology parsing and artifact generation
- **js-yaml** — YAML parsing for template files
- **@multi-agent-protocol/sdk** (optional peer dependency) — MAP protocol client, only needed when `map.enabled: true`
- **Claude Code agent teams** — enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json

## Development notes
- Templates in `templates/` are copied from openteams' `examples/` directory
- The generate-agents script has a fallback mode when openteams isn't installed (basic YAML parsing)
- Generated artifacts go in `.generated/` which should be gitignored
- openteams is config/generation only — Claude Code native teams handle all runtime coordination, MAP handles external observability
- All logic is in `src/` modules — scripts are thin wrappers, making functions importable and testable
- See `docs/design.md` for detailed architecture decisions and `docs/implementation-plan.md` for phase breakdown
