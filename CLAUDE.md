# claude-code-swarm

Claude Code plugin that launches agent teams from openteams YAML topologies, using Claude Code's native team features for coordination, optional MAP (Multi-Agent Protocol) for external observability, and optional OpenTasks for cross-system task graph integration.

## What this plugin does

This plugin bridges [openteams](https://github.com/alexngai/openteams) team templates with Claude Code's native agent teams. It provides:

1. **SessionStart hook** (`scripts/bootstrap.mjs`) — Reads `.swarm/claude-swarm/config.json`, installs deps, initializes swarmkit project packages, starts MAP sidecar if configured, and injects team context
2. **MAP integration** (`scripts/map-sidecar.mjs`, `scripts/map-hook.mjs`) — Persistent sidecar for external observability via MAP server (lifecycle events, agent registration, task bridge events)
3. **OpenTasks integration** (`src/opentasks-client.mjs`, MCP server) — Optional cross-system task graph that federates Claude Tasks, MAP tasks, and external systems. Registered as an MCP server for agent use; bridge hooks emit task events to MAP for observability
4. **`/swarm` skill** (`skills/swarm/SKILL.md`) — User-invocable skill to select a template, create a native Claude Code team via `TeamCreate`, and spawn a coordinator agent
5. **Agent generator** (`scripts/generate-agents.mjs`) — Converts openteams YAML templates into Claude Code AGENT.md files with native team tool instructions
6. **Team loader** (`scripts/team-loader.mjs`) — Resolves templates, generates artifacts (with per-template caching), writes roles.json for MAP hook integration
7. **minimem integration** (MCP server) — Optional agent memory with semantic search. Registered as an MCP server; agents use memory tools to recall past decisions and context
8. **skill-tree integration** (`src/skilltree-client.mjs`) — Optional per-role skill loadouts compiled from team.yaml `skilltree:` extension and embedded in AGENT.md files at generation time

## Plugin structure

```
claude-code-swarm/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/hooks.json              # Hook configuration (SessionStart, MAP hooks)
├── package.json                  # type:module, exports, bin, deps
├── src/                          # Core logic modules
│   ├── index.mjs                 # Barrel re-export of public API
│   ├── config.mjs                # Config parsing + defaults
│   ├── log.mjs                   # Structured leveled logging (JSON Lines + stderr)
│   ├── paths.mjs                 # Path constants + ensureSwarmDir/ensureMapDir/teamDir
│   ├── roles.mjs                 # Role reading, matching, writing roles.json
│   ├── inbox.mjs                 # Inbox read/clear/format/write
│   ├── map-connection.mjs        # MAP SDK connection + fire-and-forget
│   ├── sidecar-client.mjs        # UNIX socket client + recovery
│   ├── sidecar-server.mjs        # UNIX socket server + command handler
│   ├── map-events.mjs            # Event builders + emit (sidecar → fallback)
│   ├── opentasks-client.mjs      # OpenTasks daemon IPC client (socket discovery, task CRUD, sync)
│   ├── skilltree-client.mjs     # Skill-tree loadout compilation (per-role, cached)
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
├── settings.json                 # Enables agent teams, allows openteams/node commands
├── docs/
│   ├── design.md                 # Architecture design document
│   └── implementation-plan.md    # Implementation phases and pseudocode
└── .swarm/                       # Swarm ecosystem directory (in user's project)
    ├── openteams/                # openteams project config (initialized by swarmkit)
    │   └── templates/
    ├── sessionlog/               # sessionlog config (initialized by swarmkit, if enabled)
    │   └── settings.json
    └── claude-swarm/             # Plugin-specific (managed by this plugin)
        ├── config.json           # Plugin config (template, MAP settings)
        ├── .gitignore            # Ignores tmp/
        └── tmp/                  # Generated runtime artifacts (gitignored)
            ├── teams/            # Per-template artifact cache
            │   ├── gsd/
            │   │   ├── SKILL.md
            │   │   └── agents/
            │   └── bmad-method/
            │       ├── SKILL.md
            │       └── agents/
            └── map/              # MAP runtime state
                ├── roles.json
                ├── sidecar.sock
                ├── inbox.jsonl
                ├── sidecar.pid
                ├── sidecar.log
                └── sessionlog-state.json
```

## How to use

### Quick start
1. Create `.swarm/claude-swarm/config.json` in your project:
   ```json
   { "template": "gsd" }
   ```
2. Start a Claude Code session — the hook loads the team automatically
3. Use `/swarm gsd` to launch — this creates a native Claude Code team and spawns a coordinator

### How launching works

1. `/swarm` calls `openteams generate all` to produce role artifacts (SKILL.md per role) — cached per template in `.swarm/claude-swarm/tmp/teams/<template>/`
2. `/swarm` calls `TeamCreate` to set up a native Claude Code team with shared task list
3. `/swarm` spawns a **coordinator agent** (the topology's root role) with `team_name`
4. The coordinator reads the topology and spawns companions/workers (all with `team_name`)
5. Agents coordinate via **SendMessage** and track work via **TaskCreate/TaskUpdate/TaskList**

### With MAP observability
```json
{
  "template": "gsd",
  "map": {
    "server": "ws://localhost:8080"
  }
}
```

MAP is automatically enabled when `map.server` is configured (or `SWARM_MAP_SERVER` env var is set). You can explicitly disable it with `SWARM_MAP_ENABLED=false`.

MAP options:
- `server` — MAP server WebSocket URL (default: `ws://localhost:8080`). Setting this implicitly enables MAP.
- `scope` — MAP scope name (default: `swarm:<template>`)
- `systemId` — System identifier for federation (default: `system-claude-swarm`)
- `sidecar` — `"session"` (starts/stops with session, default) or `"persistent"` (user-managed)
- `reconnectIntervalMs` — Interval in ms for slow reconnection loop after SDK retries are exhausted (default: `60000`)
- `auth.token` — Authentication token appended as a query parameter to the server URL
- `auth.param` — Query parameter name for the token (default: `token`)

### With MeshPeer transport (agentic-mesh)
```json
{
  "template": "gsd",
  "map": {
    "server": "ws://localhost:8080"
  },
  "mesh": {
    "enabled": true
  }
}
```

When enabled, the sidecar uses an embedded MeshPeer (from agentic-mesh) instead of a direct MAP SDK WebSocket connection. This provides encrypted P2P transport, agent discovery via MapServer registry, and federation with hop/loop detection. Agent-inbox integration gives structured messaging, threading, and delivery tracking.

If agentic-mesh is not available, the sidecar falls back to the direct MAP SDK WebSocket connection automatically.

Mesh options:
- `enabled` — Enable MeshPeer transport (default: `false`)
- `peerId` — MeshPeer peer ID (default: `<teamName>-sidecar`)
- `mapServer` — Optional MAP server URL for hybrid mode (mesh + MAP bridge)

### With OpenTasks
```json
{
  "template": "gsd",
  "opentasks": {
    "enabled": true
  }
}
```

When enabled, the plugin registers an OpenTasks MCP server that agents can use for cross-system task operations (`create_task`, `update_task`, `link`, `annotate`, `list_tasks`, `query`). The MCP server communicates with the OpenTasks daemon over a Unix socket. When both OpenTasks and MAP are enabled, `PostToolUse(opentasks)` hooks bridge MCP tool use into MAP task events for observability.

OpenTasks is independent from Claude's native task system — native tasks have their own `claude://` provider in the OpenTasks graph (see Task concepts below).

### With sessionlog → MAP sync
```json
{
  "template": "gsd",
  "map": { "server": "ws://localhost:8080" },
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

### With minimem (agent memory)
```json
{
  "template": "gsd",
  "minimem": {
    "enabled": true,
    "provider": "auto"
  }
}
```

When enabled, the plugin registers a minimem MCP server that agents can use for semantic memory search (`memory_search`, `memory_get_details`, `knowledge_search`, `knowledge_graph`, `knowledge_path`). Memories are stored as Markdown files in `.swarm/minimem/` and indexed with vector embeddings + BM25 hybrid search. Memory is shared team-wide — all agents search the same store.

Minimem options:
- `enabled` — Enable minimem integration (default: `false`)
- `provider` — Embedding provider: `openai`, `gemini`, `local`, `auto`, `none` (default: `auto`)
- `global` — Also search the user's global memory store at `~/.minimem` (default: `false`)
- `dir` — Custom memory directory path (default: `.swarm/minimem/`)

### With skill-tree (per-role skill loadouts)
```json
{
  "template": "gsd",
  "skilltree": {
    "enabled": true,
    "defaultProfile": "implementation"
  }
}
```

When enabled, the plugin compiles per-role skill loadouts from the team.yaml `skilltree:` extension namespace and embeds them in each agent's AGENT.md at generation time. Skills are cached per template alongside other artifacts.

Define per-role loadouts in team.yaml:
```yaml
skilltree:
  defaults:
    profile: implementation
    maxSkills: 6
  roles:
    orchestrator:
      profile: code-review
    executor:
      profile: implementation
      tags: [development]
    verifier:
      profile: testing
    debugger:
      profile: debugging
```

Skill-tree options:
- `enabled` — Enable skill-tree integration (default: `false`)
- `basePath` — Path to skill-tree storage directory (default: `.swarm/skill-tree/`)
- `defaultProfile` — Default profile when no role-specific criteria exist (default: `""`)

### Logging
```json
{
  "template": "gsd",
  "log": {
    "level": "debug",
    "dir": "/tmp/swarm-logs"
  }
}
```

Structured logging with leveled output (JSON Lines to file, human-readable to stderr). All log output goes through `src/log.mjs` via `createLogger("module")`.

**Log levels** (each level includes all levels above it):
- `error` — something broke
- `warn` — degraded but functional (default)
- `info` — lifecycle events (sidecar started, template loaded, package installed)
- `debug` — verbose internals (cache hits, socket connects, IPC payloads)

**Per-session log files**: Each Claude Code session writes to its own log file at `<dir>/<sessionId>.log`. The session ID comes from Claude Code's hook data and is available in all entry points (bootstrap, hooks, sidecar).

**Default log directory**: `~/.claude-swarm/tmp/logs/` (always global, not project-scoped).

Log options:
- `level` — Log level threshold (default: `warn`)
- `file` — Explicit log file path, overrides per-session paths (default: `""`)
- `dir` — Directory for per-session log files (default: `~/.claude-swarm/tmp/logs/`)
- `stderr` — Also write human-readable output to stderr (default: `true`)

Quick debugging:
```bash
SWARM_LOG_LEVEL=debug claude    # all levels, per-session file
SWARM_LOG_LEVEL=info claude     # lifecycle + warnings + errors
```

### Available templates

Templates are provided by the openteams package (installed via swarmkit). Built-in templates include:
- **gsd** — 12-role system with wave-based parallel execution, goal-backward verification
- **bmad-method** — 10-role agile team across 4 phases (analysis, planning, solutioning, implementation)
- **bug-fix-pipeline** — Linear pipeline for autonomous bug fixing
- **docs-sync** — Fan-out/fan-in documentation pipeline
- **security-audit** — Fan-out/fan-in security scanning pipeline
- And more — run `openteams generate catalog` or use `/swarm` to see all available templates

### Custom templates
Point to any openteams template directory:
```json
{ "template": "/path/to/your/template" }
```

### Environment variable overrides

All config values can be overridden via `SWARM_*` environment variables. Priority: env var > config file > defaults.

| Config field | Environment variable | Type | Default |
|---|---|---|---|
| `template` | `SWARM_TEMPLATE` | string | `""` |
| `map.server` | `SWARM_MAP_SERVER` | string | `ws://localhost:8080` |
| `map.enabled` | `SWARM_MAP_ENABLED` | boolean (`true`/`1`/`yes`) | implicit (see below) |
| `map.scope` | `SWARM_MAP_SCOPE` | string | `""` (derived from template) |
| `map.systemId` | `SWARM_MAP_SYSTEM_ID` | string | `system-claude-swarm` |
| `map.sidecar` | `SWARM_MAP_SIDECAR` | string | `session` |
| `map.reconnectIntervalMs` | `SWARM_MAP_RECONNECT_INTERVAL` | number (ms) | `60000` |
| `map.auth.token` | `SWARM_MAP_AUTH_TOKEN` | string | `""` |
| `map.auth.param` | `SWARM_MAP_AUTH_PARAM` | string | `token` |
| `opentasks.enabled` | `SWARM_OPENTASKS_ENABLED` | boolean (`true`/`1`/`yes`) | `false` |
| `opentasks.scope` | `SWARM_OPENTASKS_SCOPE` | string | `""` |
| `sessionlog.enabled` | `SWARM_SESSIONLOG_ENABLED` | boolean (`true`/`1`/`yes`) | `false` |
| `sessionlog.sync` | `SWARM_SESSIONLOG_SYNC` | string | `off` |
| `minimem.enabled` | `SWARM_MINIMEM_ENABLED` | boolean (`true`/`1`/`yes`) | `false` |
| `minimem.provider` | `SWARM_MINIMEM_PROVIDER` | string | `auto` |
| `minimem.global` | `SWARM_MINIMEM_GLOBAL` | boolean (`true`/`1`/`yes`) | `false` |
| `minimem.dir` | `SWARM_MINIMEM_DIR` | string | `""` |
| `skilltree.enabled` | `SWARM_SKILLTREE_ENABLED` | boolean (`true`/`1`/`yes`) | `false` |
| `skilltree.basePath` | `SWARM_SKILLTREE_BASE_PATH` | string | `""` |
| `skilltree.defaultProfile` | `SWARM_SKILLTREE_DEFAULT_PROFILE` | string | `""` |
| `mesh.enabled` | `SWARM_MESH_ENABLED` | boolean (`true`/`1`/`yes`) | `false` |
| `mesh.peerId` | `SWARM_MESH_PEER_ID` | string | `""` |
| `mesh.mapServer` | `SWARM_MESH_MAP_SERVER` | string | `""` |
| `log.level` | `SWARM_LOG_LEVEL` | string | `warn` |
| `log.file` | `SWARM_LOG_FILE` | string | `""` (per-session default) |
| `log.dir` | `SWARM_LOG_DIR` | string | `""` (`~/.claude-swarm/tmp/logs/`) |
| `log.stderr` | `SWARM_LOG_STDERR` | boolean | `true` |

MAP is implicitly enabled when `map.server` is configured (in file or via `SWARM_MAP_SERVER`). Use `SWARM_MAP_ENABLED=false` to explicitly disable.

Example — point to a MAP server in CI (implicitly enables MAP):
```bash
SWARM_MAP_SERVER=ws://map.ci.internal:8080 claude
```

## Task concepts

There are three distinct "task" systems in play. They are independent — each has its own storage and lifecycle:

- **Claude Native Tasks** (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskStop`) — Team-wide coordination between agents. Stored by Claude Code's internal task system. The OpenTasks `claude-tasks` provider surfaces these as `claude://` nodes in the graph via a filesystem-backed `ClaudeTaskStore` adapter with chokidar file watching — no swarm hooks needed to sync them.

- **OpenTasks** (MCP tools: `create_task`, `update_task`, `link`, etc.) — Cross-system persistent task graph stored in JSONL. Federates tasks from multiple providers (`native://`, `claude://`, `map://`, `beads://`, etc.) via edges. Optional — enabled via `opentasks.enabled` config.

- **MAP Tasks** — Remote tasks on a MAP server, surfaced as `map://` nodes by the OpenTasks MAP provider. Ephemeral/pass-through — no local cache. Used for cross-system coordination when agents on different MAP-connected systems need to share tasks.

The swarm plugin's role is **observability bridging**, not task creation:
- `PostToolUse(TaskCreate/TaskUpdate)` → emits MAP bridge events so external observers can see native task activity
- `PostToolUse(opentasks)` → emits MAP bridge events when agents use opentasks MCP tools
- `TaskCompleted` → updates the opentasks graph + emits MAP bridge event
- Agent spawning/completion hooks manage MAP agent lifecycle only (not task creation)

## Architecture

### Team launch flow

1. **SessionStart** → `scripts/bootstrap.mjs`: reads config, installs deps via swarmkit, initializes `.swarm/` project packages (openteams, sessionlog), starts MAP sidecar, outputs context
2. **`/swarm`** → generates artifacts via `openteams generate all` (cached per template in `.swarm/claude-swarm/tmp/teams/<template>/`), calls `TeamCreate`, spawns coordinator agent with `team_name`
3. **Coordinator** → reads topology, spawns companions/workers (all with `team_name`), creates tasks via `TaskCreate`, coordinates via `SendMessage`

### Per-template caching

Team artifacts are cached per template under `.swarm/claude-swarm/tmp/teams/<template-name>/` (gitignored via `.swarm/claude-swarm/.gitignore`). When switching between templates (e.g. from gsd to bmad-method and back), previously generated artifacts are reused instantly. The cache is invalidated by deleting the template's directory.

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
1. **UserPromptSubmit** → `map-hook.mjs inject`: reads MAP inbox, injects external messages into context. Forwards incoming `task.*` events to the opentasks graph if `opentasks.enabled`
2. **PostToolUse(opentasks)** → `map-hook.mjs opentasks-mcp-used`: bridges opentasks MCP tool use into MAP task events (`bridge-task-created`, `bridge-task-status`, `bridge-task-assigned`, `task.linked`, `task.sync`). Gated on both `opentasks.enabled` and `map.enabled`
3. **PostToolUse(TaskCreate)** → `map-hook.mjs native-task-created`: emits `bridge-task-created` + `bridge-task-assigned` to MAP. Observability only — native tasks enter the opentasks graph via the `claude-tasks` provider, not this hook
4. **PostToolUse(TaskUpdate)** → `map-hook.mjs native-task-updated`: emits `bridge-task-status` to MAP. Observability only
5. **TaskCompleted** → `map-hook.mjs task-completed`: updates task in opentasks daemon (`updateTask`) + emits `bridge-task-status` to MAP
6. **Stop** → `map-hook.mjs turn-completed`: updates sidecar state via `conn.updateState("idle")` (server auto-emits `agent_state_changed`)
7. **Stop** → `map-hook.mjs sessionlog-sync`: reads sessionlog state, reports `trajectory/checkpoint` to MAP (falls back to `trajectory.checkpoint` message payload if server doesn't support trajectory)
8. **SubagentStart** → `map-hook.mjs subagent-start`: spawns subagent via `conn.spawn()` with `role: "subagent"`
9. **SubagentStop** → `map-hook.mjs subagent-stop`: marks subagent done
10. **TeammateIdle** → `map-hook.mjs teammate-idle`: updates teammate state to idle

### MAP sidecar

The sidecar (`scripts/map-sidecar.mjs`) is a persistent Node.js process with two transport modes:

**Mesh mode** (preferred, when `mesh.enabled: true`):
- Creates an embedded MeshPeer (from agentic-mesh) for encrypted P2P transport
- Passes the MeshPeer to agent-inbox Phase 2 integration for structured messaging, agent registry, and federation
- Agent lifecycle (spawn/done) handled by inbox registry, with MAP registration for external observability
- Task bridge events, trajectory checkpoints, and state updates go through the MeshPeer connection
- Falls back to WebSocket mode automatically if agentic-mesh is unavailable

**WebSocket mode** (fallback/default):
- Connects to the MAP server via WebSocket with auto-reconnection
- Agent lifecycle via MAP SDK primitives: `conn.spawn()`, `conn.callExtension("map/agents/unregister")`, `conn.updateState()`
- Agent-inbox shares the MAP connection for messaging (legacy integration)

Both modes:
- Listen on a UNIX socket (`.swarm/claude-swarm/tmp/map/sidecar.sock`) for commands from hooks
- Manage agent-inbox on a separate IPC socket for messaging
- Send task lifecycle as typed message payloads via `conn.send()`
- Report trajectory checkpoints via `trajectory/checkpoint` (with broadcast fallback)
- Self-terminate after 30 minutes of inactivity (session mode)

**MAP capabilities declared** (in `src/map-connection.mjs`):
- `messaging: { canSend: true, canReceive: true }` — can exchange MAP scope messages
- `mail: { canCreate: true, canJoin: true, canViewHistory: true }` — supports agent-inbox conversations (enables Mail chat mode in OpenHive session view)
- `trajectory: { canReport: true, canServeContent: true }` — reports checkpoints, serves transcript content on demand
- `tasks: { canCreate, canAssign, canUpdate, canList }` — task management
- `opentasks: { canQuery, canLink, canAnnotate, canTask }` — conditional, when task_graph configured

Message delivery is **pull-based**: the `UserPromptSubmit` hook reads the inbox on each turn and injects messages into Claude Code's prompt context. No real-time push delivery.

The hook helper (`scripts/map-hook.mjs`) includes best-effort auto-recovery: if the sidecar is down, it attempts to restart it, with a fire-and-forget fallback (mesh or direct WebSocket) if recovery fails.

### OpenTasks integration

The plugin integrates with OpenTasks at two levels:

**MCP server** — Registered in `plugin.json` as an MCP server (`run-opentasks-mcp.sh`). Conditionally started based on `opentasks.enabled` config. Agents use MCP tools (`create_task`, `update_task`, `link`, `annotate`, `list_tasks`, `query`) to interact with the OpenTasks daemon over a Unix socket.

**Daemon IPC client** (`src/opentasks-client.mjs`) — Direct IPC to the OpenTasks daemon for hook-initiated operations. Socket discovery follows priority: `.swarm/opentasks/` → `.opentasks/` → `.git/opentasks/` → walk up. Used by:
- `task-completed` hook → `updateTask()` to mark tasks closed
- `inject` hook → `pushSyncEvent()` to forward incoming MAP `task.*` events to the graph
- `map-events.mjs` → `handleTaskCreated()`/`handleTaskCompleted()` (available for two-step pattern: create in opentasks + emit MAP bridge event)

**Relationship to native Claude Tasks** — Native tasks (`TaskCreate`/`TaskUpdate`) enter the OpenTasks graph via the `claude-tasks` provider (in the OpenTasks project), which uses a filesystem-backed `ClaudeTaskStore` adapter with chokidar file watching. The swarm plugin does NOT need to push native tasks into OpenTasks — the provider handles this reactively. The swarm hooks for `PostToolUse(TaskCreate/TaskUpdate)` only emit MAP bridge events for observability.

### Agent registration

Only topology-defined roles (from `team.yaml`) get full MAP agent registrations via `conn.spawn()`. Subagents are also spawned in MAP with `role: "subagent"` for observability. Role matching is done via `.swarm/claude-swarm/tmp/map/roles.json` written during team loading. All agent context (role, template, agentType, isTeamRole) goes into agent `metadata`.

### Module architecture

All logic lives in `src/` as importable ES modules. Scripts in `scripts/` are thin CLI wrappers (~20-30 lines each) that parse args, call `src/` functions, and handle stdout/stderr.

```
src/config.mjs            ← readConfig(), resolveScope(), resolveTeamName()
src/log.mjs                ← createLogger(), init() — structured leveled logging
src/paths.mjs              ← SWARM_DIR, CONFIG_PATH, TMP_DIR, TEAMS_DIR, MAP_DIR, LOG_PATH, LOGS_DIR, teamDir()
src/roles.mjs              ← readRoles(), matchRole(), writeRoles()
src/inbox.mjs              ← readInbox(), clearInbox(), formatInboxAsMarkdown()
src/map-connection.mjs     ← connectToMAP(), fireAndForget(), fireAndForgetTrajectory()
src/mesh-connection.mjs    ← createMeshPeer(), createMeshInbox(), meshFireAndForget()
src/sidecar-client.mjs     ← sendToSidecar(), ensureSidecar(), startSidecar()
src/sidecar-server.mjs     ← createSocketServer(), createCommandHandler()
src/map-events.mjs         ← sendCommand(), emitPayload(), build*Command(), handle*Event()
src/opentasks-client.mjs   ← createTask(), updateTask(), pushSyncEvent(), findSocketPath()
src/skilltree-client.mjs   ← parseSkillTreeExtension(), compileRoleLoadout(), compileAllRoleLoadouts()
src/sessionlog.mjs         ← findActiveSession(), buildTrajectoryCheckpoint(), syncSessionlog()
src/template.mjs           ← resolveTemplatePath(), listAvailableTemplates(), generateTeamArtifacts()
src/agent-generator.mjs    ← generateAllAgents(), generateAgentMd()
src/context-output.mjs     ← format*Context(), format*Message()
src/bootstrap.mjs          ← bootstrap() — full SessionStart orchestration
src/index.mjs              ← barrel re-export of public API
```

## Key dependencies

Local (installed via `npm install --production` in plugin directory):
- **swarmkit** — bundled package manager for the swarm ecosystem (global package installation)
- **js-yaml** — YAML parsing for template files

Global (managed by swarmkit, installed on demand during bootstrap):
- **openteams** — team topology parsing and artifact generation (always installed)
- **@multi-agent-protocol/sdk** — MAP protocol client (installed when `map.enabled: true`)
- **agentic-mesh** — encrypted P2P mesh transport with embedded MeshPeer (installed when `mesh.enabled: true`)
- **agent-inbox** — MAP-native message router with structured messaging (installed when `inbox.enabled: true`)
- **sessionlog** — git-integrated session capture (installed when `sessionlog.enabled: true`)
- **minimem** — file-based memory with vector search (installed when `minimem.enabled: true`)
- **skill-tree** — versioned skill library with serving layer (installed when `skilltree.enabled: true`)

Runtime:
- **Claude Code agent teams** — enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json

## Development notes

### Debugging with logs
When logging is enabled, per-session log files (JSON Lines format) are written to:
- **Default location**: `~/.claude-swarm/tmp/logs/<timestamp>_<sessionId>.log`
- **Custom location**: set `log.dir` in config or `SWARM_LOG_DIR` env var
- **Explicit file**: set `log.file` in config or `SWARM_LOG_FILE` env var

To enable verbose logging: `SWARM_LOG_LEVEL=debug claude` (or `info` for lifecycle events only). The default level is `warn`. Each session may produce multiple log files (e.g., one from bootstrap, one from the sidecar) sharing the same session ID in the filename.

### General notes
- Templates are provided by the openteams package (installed via swarmkit), not bundled with the plugin
- `.swarm/` directory is managed by swarmkit for ecosystem packages (openteams, sessionlog) via `initProjectPackage()`
- Plugin-specific state lives under `.swarm/claude-swarm/` (config, `.gitignore` ignoring `tmp/`). Runtime artifacts go in `.swarm/claude-swarm/tmp/` (per-template caches, MAP files)
- Switching between templates is instant if previously cached — artifacts are stored per template in `.swarm/claude-swarm/tmp/teams/<template>/`
- openteams is config/generation only — Claude Code native teams handle all runtime coordination, MAP handles external observability
- All logic is in `src/` modules — scripts are thin wrappers, making functions importable and testable
- Agent spawning/completion hooks are purely MAP agent lifecycle — they do not create or complete tasks. Task creation is handled by agents using `TaskCreate` (native) or opentasks MCP tools
- Native Claude tasks enter the OpenTasks graph via the `claude-tasks` provider's filesystem watcher, not via swarm hooks. Swarm hooks for `TaskCreate`/`TaskUpdate` only emit MAP bridge events
- The `opentasks-client.mjs` communicates with the OpenTasks daemon via JSON-RPC 2.0 over Unix socket with best-effort auto-recovery
- See `docs/design.md` for detailed architecture decisions and `docs/implementation-plan.md` for phase breakdown
