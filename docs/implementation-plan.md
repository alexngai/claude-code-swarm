# Implementation Plan

Concrete implementation steps for the MAP + sessionlog integration, based on `docs/design.md`.

## Current state

```
hooks/hooks.json              ← SessionStart: inline shell command (~1 long line)
settings.json                 ← env: AGENT_TEAMS=1, permissions: openteams/npm
scripts/team-loader.sh        ← Used by /swarm skill, NOT by the SessionStart hook
scripts/generate-agents.mjs   ← Templates → AGENT.md (includes openteams messaging)
skills/swarm/SKILL.md          ← /swarm skill definition
.claude-plugin/plugin.json     ← Plugin manifest v0.1.0
```

Key observation: the current `SessionStart` hook and `team-loader.sh` are separate code paths. The hook is a minimal inline check; `team-loader.sh` does the actual generation and is invoked by the `/swarm` skill. This separation is intentional — the hook just announces the plugin, while `/swarm` does the heavy lifting.

We keep this separation. The new `bootstrap.sh` replaces the inline hook command but stays lightweight (config check, status reporting, sidecar launch). It does NOT generate agents or load teams — that's still `/swarm`'s job.

---

## Phase 1: Foundation

**Goal:** Replace inline hook with `bootstrap.sh`, add new hook events, update config/permissions.

### 1.1 Create `scripts/bootstrap.sh`

The unified `SessionStart` entry point. Replaces the inline command in `hooks/hooks.json`.

```bash
#!/usr/bin/env bash
# bootstrap.sh — SessionStart hook for claude-code-swarm
# Reads .claude-swarm.json, checks integrations, starts MAP sidecar if configured.
# Output goes to stdout → injected into Claude's context.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE=".claude-swarm.json"

# ── 1. Read config ───────────────────────────────────────────────────────────
TMPL=""
MAP_ENABLED="false"
MAP_SERVER=""
MAP_SCOPE=""
MAP_SYSTEM_ID=""
MAP_SIDECAR="session"
SESSIONLOG_ENABLED="false"

if [ -f "$CONFIG_FILE" ]; then
  eval "$(node -e "
    const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
    console.log('TMPL=' + JSON.stringify(c.template || ''));
    console.log('MAP_ENABLED=' + JSON.stringify(String(c.map?.enabled || false)));
    console.log('MAP_SERVER=' + JSON.stringify(c.map?.server || 'ws://localhost:8080'));
    console.log('MAP_SCOPE=' + JSON.stringify(c.map?.scope || ''));
    console.log('MAP_SYSTEM_ID=' + JSON.stringify(c.map?.systemId || 'system-claude-swarm'));
    console.log('MAP_SIDECAR=' + JSON.stringify(c.map?.sidecar || 'session'));
    console.log('SESSIONLOG_ENABLED=' + JSON.stringify(String(c.sessionlog?.enabled || false)));
  " 2>/dev/null)"
fi

# Auto-derive scope from template name if not set
if [ -n "$TMPL" ] && [ -z "$MAP_SCOPE" ]; then
  MAP_SCOPE="swarm:$TMPL"
fi

# ── 2. Ensure openteams is available ─────────────────────────────────────────
if ! command -v openteams &>/dev/null; then
  echo "Installing openteams..." >&2
  npm install -g openteams 2>&1 >&2 || true
fi

# ── 3. Check sessionlog status ───────────────────────────────────────────────
SESSIONLOG_STATUS="not installed"
if command -v sessionlog &>/dev/null; then
  if sessionlog status --json 2>/dev/null | node -e "
    const s = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    process.exit(s.enabled ? 0 : 1);
  " 2>/dev/null; then
    SESSIONLOG_STATUS="active"
  else
    SESSIONLOG_STATUS="installed but not enabled"
  fi
fi

# ── 4. Start MAP sidecar if configured ───────────────────────────────────────
MAP_STATUS="disabled"
if [ "$MAP_ENABLED" = "true" ]; then
  # Ensure MAP SDK is available
  if ! node -e "require('@multi-agent-protocol/sdk')" 2>/dev/null; then
    echo "Installing @multi-agent-protocol/sdk..." >&2
    npm install -g @multi-agent-protocol/sdk 2>&1 >&2 || true
  fi

  mkdir -p .generated/map

  if [ "$MAP_SIDECAR" = "session" ]; then
    # Start sidecar as background process
    node "$PLUGIN_DIR/scripts/map-sidecar.mjs" \
      --server "$MAP_SERVER" \
      --scope "$MAP_SCOPE" \
      --system-id "$MAP_SYSTEM_ID" \
      --roles-file ".generated/map/roles.json" \
      &>/dev/null &
    echo $! > .generated/map/sidecar.pid
    MAP_STATUS="connected (scope: $MAP_SCOPE)"
  elif [ "$MAP_SIDECAR" = "persistent" ]; then
    # Check if persistent sidecar is running
    if [ -S .generated/map/sidecar.sock ]; then
      MAP_STATUS="connected via persistent sidecar (scope: $MAP_SCOPE)"
    else
      MAP_STATUS="WARNING: persistent sidecar not running"
    fi
  fi
fi

# ── 5. Output context ────────────────────────────────────────────────────────
echo "## Claude Code Swarm (openteams)"
echo ""

if [ -n "$TMPL" ]; then
  echo "Team template configured: **$TMPL**"
else
  echo "No team template configured."
fi

echo "MAP: $MAP_STATUS"

if [ "$SESSIONLOG_ENABLED" = "true" ]; then
  if [ "$SESSIONLOG_STATUS" = "active" ]; then
    echo "Sessionlog: active"
  else
    echo "Sessionlog: WARNING — configured but $SESSIONLOG_STATUS"
  fi
fi

echo ""
echo "Use \`/swarm\` to launch the team, or \`/swarm <template>\` for a specific template."
echo "Built-in templates: **get-shit-done**, **bmad-method**"
```

### 1.2 Update `hooks/hooks.json`

Replace inline command with `bootstrap.sh`. Add hooks for MAP events.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$(dirname \"$0\")/../scripts/bootstrap.sh\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(dirname \"$0\")/../scripts/map-hook.mjs\" inject"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(dirname \"$0\")/../scripts/map-hook.mjs\" agent-spawning"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(dirname \"$0\")/../scripts/map-hook.mjs\" agent-completed"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(dirname \"$0\")/../scripts/map-hook.mjs\" turn-completed"
          }
        ]
      }
    ]
  }
}
```

**Note on path resolution:** `$(dirname "$0")` refers to the hooks directory in Claude Code plugin hooks. Need to verify this works — may need to use an absolute path via `PLUGIN_DIR` env var set in `settings.json`, or have `bootstrap.sh` set it.

**Alternative:** Set `CLAUDE_CODE_SWARM_DIR` in `settings.json` env and reference that.

### 1.3 Update `settings.json`

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "permissions": {
    "allow": [
      "Bash(openteams *)",
      "Bash(npm install -g openteams)",
      "Bash(npm install -g @multi-agent-protocol/sdk)",
      "Bash(npm install -g sessionlog)",
      "Bash(node *)"
    ]
  }
}
```

### 1.4 Update `.gitignore`

```
.generated/
node_modules/
agents/
```

Already correct — `.generated/` covers MAP inbox/pid/socket files.

---

## Phase 2: MAP Sidecar + Outbound Events

**Goal:** Create the sidecar process and event emission hook helper.

### 2.1 Create `scripts/map-sidecar.mjs`

The persistent process. Key responsibilities:
- Connect to MAP server via WebSocket
- Register root agent
- Listen for incoming messages → write to `inbox.jsonl`
- Accept outbound events via UNIX socket → forward to MAP server
- Register/unregister team agents on spawn/complete commands from hooks
- Self-terminate after 30 min inactivity (session mode safety net)

```
Sidecar responsibilities:
1. Parse CLI args (--server, --scope, --system-id, --roles-file)
2. Read .claude-swarm.json for team config
3. AgentConnection.connect(server, { name, role, scopes: [scope] })
4. Create UNIX socket at .generated/map/sidecar.sock
5. Listen on socket for hook commands:
   - { action: "emit", event: {...} }           → agent.send(scope, event)
   - { action: "register", agent: {...} }       → register child agent
   - { action: "unregister", agentId: "..." }   → unregister child agent
   - { action: "state", state: "busy" }         → agent.updateState()
6. agent.onMessage(msg => appendFile(inbox.jsonl, JSON.stringify(msg)))
7. Inactivity timer: reset on any socket command; SIGTERM self after 30min
8. SIGTERM handler: agent.disconnect(), unlink socket/pid, exit
```

**Implementation structure:**

```javascript
#!/usr/bin/env node
// map-sidecar.mjs — MAP sidecar for claude-code-swarm

import { AgentConnection } from '@multi-agent-protocol/sdk';
import net from 'net';
import fs from 'fs';
import path from 'path';

// Parse args
// Connect to MAP server
// Create UNIX socket server
// Handle commands from hooks
// Write incoming messages to inbox
// Manage inactivity timeout
// Handle SIGTERM for cleanup
```

### 2.2 Create `scripts/map-hook.mjs`

Hook helper script. Called by each hook with an action argument. Reads stdin for hook event data.

Actions:
- `inject` — Read inbox.jsonl, format as markdown, output to stdout, truncate inbox
- `agent-spawning` — Parse PreToolUse(Task) stdin, emit swarm.agent.spawned + swarm.task.dispatched
- `agent-completed` — Parse PostToolUse(Task) stdin, emit swarm.agent.completed + swarm.task.completed
- `turn-completed` — Parse Stop stdin, emit swarm.turn.completed + update state to idle

Each emit action:
1. Try connect to sidecar UNIX socket
2. If connected: send command, done
3. If not connected + session mode: attempt auto-recovery (restart sidecar, wait 2s)
4. If still not connected: fire-and-forget via direct WebSocket
5. If fire-and-forget fails: silently drop (never block the agent)

```javascript
#!/usr/bin/env node
// map-hook.mjs — Hook helper for claude-code-swarm MAP integration

import fs from 'fs';
import net from 'net';
import path from 'path';

const action = process.argv[2]; // inject | agent-spawning | agent-completed | turn-completed

// Read .claude-swarm.json for config
// Read stdin for hook event data

switch (action) {
  case 'inject':
    // Read inbox, format, output, truncate
    break;
  case 'agent-spawning':
    // Check if agent name matches topology role
    // If yes: send register + task.dispatched to sidecar
    // If no: send only task.dispatched (no MAP registration)
    break;
  case 'agent-completed':
    // Send unregister + task.completed to sidecar
    break;
  case 'turn-completed':
    // Send state update + turn.completed to sidecar
    break;
}
```

### 2.3 Sidecar → Hook role matching

The hook needs to know which agent names are topology roles (to register them) vs internal subagents (to ignore). Two approaches:

**Option A:** At `/swarm` launch time, write `.generated/map/roles.json` with the role list from `team.yaml`. The hook reads this file.

**Option B:** The sidecar loads the role list at startup and the hook asks the sidecar "is this a team role?" via the socket.

**Go with A** — simpler, no round-trip. The `/swarm` skill already parses `team.yaml` and can write this file. The `bootstrap.sh` can also do it from the template config.

`.generated/map/roles.json`:
```json
{
  "team": "get-shit-done",
  "roles": ["orchestrator", "roadmapper", "verifier", "planner", "executor", ...],
  "root": "orchestrator",
  "companions": ["roadmapper", "verifier"]
}
```

---

## Phase 3: MAP Inbound + Recovery

**Goal:** Inject MAP messages into agent context, auto-recover crashed sidecar.

### 3.1 Inbox injection (`inject` action)

In `map-hook.mjs`, the `inject` action:

1. Check if `.generated/map/inbox.jsonl` exists and has content
2. If empty: exit 0 with no output (don't inject empty context)
3. Parse each line as JSON (`Message` type)
4. Format as structured markdown:
   ```
   ## [MAP] N pending messages

   **From <name>** (role: <role>, Ns ago)
   > <payload summary>
   > Priority: <priority>
   ```
5. Write formatted output to stdout
6. Truncate inbox file (or rename to `.processed`)

### 3.2 Auto-recovery logic

In `map-hook.mjs`, before any action that requires the sidecar:

```javascript
async function ensureSidecar(config) {
  // 1. Try connect to socket
  const sock = tryConnect('.generated/map/sidecar.sock');
  if (sock) return sock;

  // 2. Check if session mode (we manage the sidecar)
  if (config.map.sidecar !== 'session') return null;

  // 3. Check PID file
  const pid = readPidFile('.generated/map/sidecar.pid');
  if (pid && isProcessAlive(pid)) {
    // Sidecar is running but socket not ready yet — wait briefly
    await waitForSocket('.generated/map/sidecar.sock', 1000);
    return tryConnect('.generated/map/sidecar.sock');
  }

  // 4. Sidecar is dead — restart
  const child = spawn('node', [
    path.join(pluginDir, 'scripts/map-sidecar.mjs'),
    '--server', config.map.server,
    '--scope', config.map.scope,
    // ...
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync('.generated/map/sidecar.pid', String(child.pid));

  // 5. Wait for socket
  await waitForSocket('.generated/map/sidecar.sock', 2000);
  return tryConnect('.generated/map/sidecar.sock');
}
```

---

## Phase 4: Team Agent Registration

**Goal:** Sidecar registers team-level agents in MAP on spawn.

### 4.1 Role matching in `map-hook.mjs`

When `agent-spawning` action fires:

```javascript
case 'agent-spawning': {
  const hookData = JSON.parse(await readStdin());
  const agentName = hookData.tool_input?.name || '';
  const roles = JSON.parse(fs.readFileSync('.generated/map/roles.json', 'utf-8'));

  // Extract role name from agent name (e.g., "gsd-executor" → "executor")
  // Or match directly against roles list
  const matchedRole = roles.roles.find(r =>
    agentName === r ||
    agentName === `${roles.team}-${r}` ||
    agentName.endsWith(`-${r}`)
  );

  const sidecar = await ensureSidecar(config);
  if (!sidecar) break;

  if (matchedRole) {
    // Register as team agent in MAP
    sidecar.write(JSON.stringify({
      action: 'register',
      agent: {
        agentId: `${roles.team}-${matchedRole}`,
        name: matchedRole,
        role: matchedRole,
        parent: currentAgentId,
        scopes: [config.map.scope]
      }
    }) + '\n');
  }

  // Always emit spawn event
  sidecar.write(JSON.stringify({
    action: 'emit',
    event: {
      type: 'swarm.agent.spawned',
      agent: agentName,
      role: matchedRole || 'internal',
      parent: currentAgentId,
      isTeamRole: !!matchedRole,
      task: hookData.tool_input?.prompt?.substring(0, 200)
    }
  }) + '\n');
  break;
}
```

### 4.2 Unregistration on completion

When `agent-completed` action fires:

```javascript
case 'agent-completed': {
  const hookData = JSON.parse(await readStdin());
  const agentName = hookData.tool_input?.name || '';
  const roles = JSON.parse(fs.readFileSync('.generated/map/roles.json', 'utf-8'));

  const matchedRole = roles.roles.find(r => /* same matching logic */);

  const sidecar = await ensureSidecar(config);
  if (!sidecar) break;

  if (matchedRole) {
    sidecar.write(JSON.stringify({
      action: 'unregister',
      agentId: `${roles.team}-${matchedRole}`
    }) + '\n');
  }

  sidecar.write(JSON.stringify({
    action: 'emit',
    event: {
      type: 'swarm.agent.completed',
      agent: agentName,
      role: matchedRole || 'internal',
      parent: currentAgentId,
      status: 'completed'
    }
  }) + '\n');
  break;
}
```

---

## Phase 5: Native Teams Integration

**Goal:** Replace all openteams runtime CLI usage with Claude Code native team features. openteams is now config/generation only.

### 5.1 Update `skills/swarm/SKILL.md`

The `/swarm` skill now:
1. Calls `openteams generate all` to produce role artifacts (unchanged)
2. Calls `TeamCreate` to set up a native Claude Code team
3. Spawns a **coordinator agent** (the root role) with `team_name`
4. The coordinator manages everything: spawning companions/workers, creating tasks, coordinating via SendMessage

### 5.2 Update `scripts/generate-agents.mjs`

In `determineTools()`: add `TaskList`, `TaskUpdate`, `SendMessage` for all agents; `TaskCreate` for root/companions. Remove `TodoWrite`.

In `generateAgentMd()`: replace the "Team Coordination" section:

**Remove all openteams CLI references:**
- `openteams task list/update` — replaced by `TaskList`/`TaskUpdate`
- `openteams template emit/events` — replaced by `SendMessage`
- `openteams message send/poll` — replaced by `SendMessage`
- MAP scope references — agents don't need to know about MAP

**Replace with:**
- `SendMessage` usage instructions with role-specific communication patterns from topology
- `TaskList`/`TaskUpdate` for task management; `TaskCreate` for root/companions
- Topology-derived routing patterns (from `manifest.communication.routing.peers`)
- Signal emission/subscription mapped to SendMessage guidance
- Optional MAP note: "lifecycle events emitted automatically, no interaction needed"

### 5.3 Update `scripts/team-loader.sh`

Replace openteams CLI instructions with native team references:
- `TeamCreate` for team setup
- `TaskCreate`/`TaskUpdate` for task lifecycle
- `SendMessage` for agent-to-agent communication

Keep `roles.json` generation (still needed for MAP hook role matching).

### 5.4 Update `scripts/bootstrap.sh`

Minor text updates:
- Remove "(openteams)" from header
- Update `/swarm` description to mention native teams

---

## Phase 6: Polish

### 6.1 Update `CLAUDE.md`

Reflect new architecture:
- openteams is config/generation only (no runtime CLI usage)
- Claude Code native teams handle all runtime coordination (TeamCreate, TaskCreate/TaskUpdate, SendMessage)
- MAP handles external observability only
- Coordinator agent pattern: `/swarm` → TeamCreate → spawn coordinator → coordinator manages team

### 6.3 Update `.claude-plugin/plugin.json`

Bump version to `0.2.0`.

### 6.4 Error handling

- `map-hook.mjs`: all operations wrapped in try/catch, never exit non-zero (don't block agent)
- `map-sidecar.mjs`: reconnection on WebSocket drop (MAP SDK has built-in reconnection support)
- `bootstrap.sh`: all failures are warnings, never `exit 1`

---

## Dependency graph

```
Phase 1 (foundation)
  ├── bootstrap.sh
  ├── hooks.json update
  └── settings.json update
       │
Phase 2 (sidecar + outbound)
  ├── map-sidecar.mjs  ← depends on Phase 1 (hooks.json wiring)
  └── map-hook.mjs     ← depends on Phase 1 (hooks.json wiring)
       │
Phase 3 (inbound + recovery)
  └── inject action + auto-recovery  ← depends on Phase 2 (sidecar exists)
       │
Phase 4 (agent registration)
  └── role matching + register/unregister  ← depends on Phase 2 (sidecar)
       │                                     depends on Phase 5.3 (roles.json)
Phase 5 (code gen updates)
  ├── generate-agents.mjs update  ← independent
  ├── team-loader.sh update       ← independent
  └── roles.json writing          ← independent
       │
Phase 6 (polish)
  └── docs, SKILL.md, error handling  ← depends on all above
```

Phases 2-4 are sequential (each builds on the previous). Phase 5 is independent and can be done in parallel with Phase 2.

---

## Testing approach

### Manual testing

1. **Phase 1:** Start a Claude Code session with the plugin installed. Verify `bootstrap.sh` output appears in context. Test with/without `.claude-swarm.json`.

2. **Phase 2:** Start a MAP server (`npx @multi-agent-protocol/server`). Configure `.claude-swarm.json` with `map.enabled: true`. Verify sidecar starts. Use a `ClientConnection` script to subscribe and verify events appear when agents are spawned.

3. **Phase 3:** Send a message to the sidecar's agent via MAP. Verify it appears in the next turn's context. Kill the sidecar mid-session, verify auto-recovery on next prompt.

4. **Phase 4:** Launch `/swarm get-shit-done`. Verify team agents appear in MAP agent list. Verify internal subagents do NOT appear.

### Automated testing (future)

- Unit tests for `map-hook.mjs` actions (mock stdin, verify output)
- Integration test: sidecar + MAP server + hook simulation
- Recovery test: kill sidecar, verify hook restarts it
