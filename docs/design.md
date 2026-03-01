# claude-code-swarm — Integration Design

Design document for integrating MAP (Multi-Agent Protocol) and sessionlog into the claude-code-swarm plugin.

## Status

**Draft v2** — updated with decisions from design review.

### Key decisions made

- **openteams** is structural only — team topology, roles, spawn rules. Its messaging layer (`openteams message send/poll`) is dropped in favor of MAP.
- **MAP** handles all runtime communication — observability events, agent coordination, and (v2) inter-agent messaging.
- **sessionlog** is fully independent — the swarm plugin checks its status but does not manage its lifecycle.
- **Sidecar mode is configurable** — session-scoped (starts/stops with the session) or persistent (user manages externally).
- **MAP server** is user-provisioned — the plugin connects, doesn't start a server.
- **MAP scope** is per swarm team — all agents in a team share one scope.

---

## 1. Context

### What exists today

claude-code-swarm is a Claude Code plugin that launches agent teams from openteams YAML topologies. The current architecture:

```
.claude-swarm.json          ← project config (template name)
hooks/hooks.json            ← SessionStart hook (installs openteams, loads team context)
settings.json               ← enables agent teams, allows openteams CLI
skills/swarm/SKILL.md       ← /swarm skill definition
scripts/generate-agents.mjs ← openteams templates → AGENT.md files
templates/                  ← bundled team topologies (get-shit-done, bmad-method)
```

**Coordination today:** Agents coordinate via the openteams CLI (`openteams task`, `openteams message send/poll`, `openteams template emit`). Each generated AGENT.md includes a CLI quick-reference section. Coordination is text-based — agents include CLI commands in their Bash tool calls.

### What we want to add

1. **MAP** — Real-time observability and coordination protocol for the agent swarm
2. **sessionlog** — Session tracking, checkpointing, and rewind capability

Both are opt-in via `.claude-swarm.json` configuration.

### What changes about openteams

openteams retains its role as the **structural layer** — team topology definitions, role specifications, spawn rules, and signal/channel schemas. Its runtime messaging (`openteams message send/poll`) is superseded by MAP, which provides:
- Push delivery instead of polling
- Real-time observability via event subscriptions
- Cross-turn message injection via hooks
- Structured addressing (by agent, role, scope, hierarchy)

openteams CLI commands retained:
- `openteams template load` — initialize team state
- `openteams generate all` — generate role artifacts
- `openteams task list/create/update` — task lifecycle
- `openteams template emit/events` — signal emission (maps to MAP events)

openteams CLI commands dropped:
- `openteams message send` — replaced by MAP `agent.send()`
- `openteams message poll` — replaced by MAP sidecar inbox + hook injection

---

## 2. Systems Overview

### 2.1 MAP (Multi-Agent Protocol)

**Package:** `@multi-agent-protocol/sdk@0.0.12` (npm)

#### Core types (from SDK)

```typescript
// Message — the fundamental unit
interface Message<T = unknown> {
  id: MessageId;        // ULID, auto-generated
  from: ParticipantId;  // sender (agent ID or participant ID)
  to: Address;          // recipient(s)
  timestamp: Timestamp; // ISO 8601
  payload?: T;          // arbitrary JSON
  meta?: MessageMeta;   // delivery semantics, priority, correlation
}

// Addressing — flexible targeting
type Address =
  | string                // shorthand agent ID
  | { agent: AgentId }    // direct to one agent
  | { agents: AgentId[] } // multi-target
  | { scope: ScopeId }    // all agents in scope
  | { role: string; within?: ScopeId }  // by role, optionally scoped
  | { parent: true }      // parent agent
  | { children: true }    // all children
  | { broadcast: true }   // all agents in system

// MessageMeta — optional delivery control
interface MessageMeta {
  timestamp?: Timestamp;
  relationship?: "parent-to-child" | "child-to-parent" | "peer" | "broadcast";
  expectsResponse?: boolean;
  correlationId?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  delivery?: "fire-and-forget" | "acknowledged" | "guaranteed";
  ttlMs?: number;
}

// Agent — registered entity
interface Agent {
  id: AgentId;
  name?: string;
  description?: string;
  parent?: AgentId;
  children?: AgentId[];
  state: "registered" | "active" | "busy" | "idle" | "suspended" | "stopping" | "stopped" | "failed";
  role?: string;
  scopes?: ScopeId[];
  metadata?: Record<string, unknown>;
}

// AgentConnection — per-agent client
class AgentConnection {
  constructor(stream: Stream, options?: AgentConnectionOptions);
  static connect(url: string, options?: AgentConnectOptions): Promise<AgentConnection>;

  connect(options?): Promise<ConnectResponseResult>;
  disconnect(): Promise<string | undefined>;

  send(to: Address, payload?: unknown, meta?: MessageMeta): Promise<SendResponseResult>;
  sendToParent(payload?, meta?): Promise<SendResponseResult>;
  sendToChildren(payload?, meta?): Promise<SendResponseResult>;

  onMessage(handler: (message: Message) => void): this;
  offMessage(handler): this;

  updateState(state: AgentState): Promise<Agent>;
  subscribe(filter?: SubscriptionFilter): Promise<Subscription>;
}

// AgentConnectOptions — used with static connect()
interface AgentConnectOptions {
  name?: string;
  role?: string;
  parent?: AgentId;
  scopes?: ScopeId[];
  metadata?: Record<string, unknown>;
  auth?: { method: 'bearer' | 'api-key' | 'mtls' | 'none'; token?: string };
  reconnection?: true | false | AgentReconnectionOptions;
}
```

#### Built-in event types

MAP server emits these events automatically (observable via `subscribe()`):

```
agent_registered         agent_unregistered       agent_state_changed
participant_connected    participant_disconnected
message_sent             message_delivered        message_failed
scope_created            scope_deleted
scope_member_joined      scope_member_left
```

These are free observability — any `ClientConnection` subscriber sees them without the agents doing anything special.

#### Transports

```typescript
import { websocketStream, ndJsonStream, createStreamPair } from '@multi-agent-protocol/sdk';

websocketStream(ws)       // WebSocket (remote servers)
ndJsonStream(stdin, out)  // stdio (local pipes)
createStreamPair()        // in-process (testing)
```

### 2.2 sessionlog

**Package:** `sessionlog` (npm)

sessionlog tracks Claude Code sessions in git with zero runtime dependencies:
- **Session state** stored in `.git/sessionlog-sessions/<id>.json`
- **Checkpoints** on shadow branches (`sessionlog/<base-commit[:7]>`)
- **Committed checkpoints** on `sessionlog/checkpoints/v1` branch
- **Secret redaction** (30+ patterns + entropy detection) applied to transcripts
- **Subagent tracking** via `SubagentAwareExtractor` — rolls up token usage and file changes across the entire agent tree
- **Rewind** — restore project to any checkpoint state
- **Resume** — discover and continue sessions from branches

sessionlog installs its own Claude Code hooks programmatically into `.claude/settings.json`:
- `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`
- `PreToolUse(Task)`, `PostToolUse(Task)` — subagent lifecycle
- `PostToolUse(TodoWrite)` — compaction events

And 4 git hooks: `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-push`.

### 2.3 openteams (structural layer only)

**Package:** `openteams` (npm)

openteams provides the team definition layer:
- **Templates** — YAML topology definitions with roles, spawn rules, communication channels
- **Task management** — `openteams task list/create/update` (retained for structured task lifecycle)
- **Signal definitions** — channel/signal schemas from `team.yaml` (emitted as MAP events)
- **Code generation** — `openteams generate all` produces role artifacts

**Not used at runtime:** `openteams message send/poll` (replaced by MAP).

---

## 3. Architecture

### 3.1 The Hook Model — Constraints and Opportunities

Claude Code hooks are fire-and-forget shell commands. Key properties:

| Hook Event | stdin | stdout (exit 0) | Can Block? |
|---|---|---|---|
| `SessionStart` | `{ session_id, cwd, source }` | Injected into context | No |
| `UserPromptSubmit` | `{ session_id, cwd, prompt }` | Injected into context | Yes (exit 2) |
| `PreToolUse` | `{ session_id, tool_name, tool_input }` | JSON decision | Yes (exit 2) |
| `PostToolUse` | `{ session_id, tool_name, tool_output }` | — | No |
| `Stop` | `{ session_id, stop_reason }` | — | No |

**Critical insight:** `SessionStart` and `UserPromptSubmit` hooks can inject text directly into Claude's conversation context by writing to stdout. This is the bridge for MAP inbound coordination — a hook can read queued MAP messages and inject them as context before the agent processes the prompt.

**Limitation:** Hooks are synchronous, short-lived processes. They cannot maintain persistent connections. A long-running sidecar process is needed for real-time MAP message reception.

### 3.2 Layered Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Claude Code Session                 │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ SessionStart │  │ UserPrompt   │  │ PostTool  │  │
│  │    Hook      │  │ Submit Hook  │  │   Hook    │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│         │                 │                │         │
└─────────┼─────────────────┼────────────────┼─────────┘
          │                 │                │
    ┌─────▼─────┐     ┌────▼─────┐    ┌─────▼──────┐
    │ Bootstrap │     │  Inject  │    │   Emit     │
    │ (start    │     │  MAP     │    │   MAP      │
    │ sidecar,  │     │  inbox   │    │   events   │
    │ check     │     │  context │    │            │
    │ sessionlog│     └────┬─────┘    └─────┬──────┘
    └─────┬─────┘          │                │
          │           ┌────▼────────────────▼──────┐
          │           │      MAP Sidecar           │
          ▼           │  (persistent WebSocket)    │
    ┌───────────┐     │                            │
    │ sessionlog│     │  inbox/  ← received msgs   │
    │ (own hooks│     │  outbox/ → sent events     │
    │ own life- │     └────────────┬───────────────┘
    │ cycle)    │                  │
    └───────────┘           ┌─────▼──────┐
                            │ MAP Server │
                            │ (user-     │
                            │ provisioned│
                            └─────┬──────┘
                                  │ federation
                            ┌─────▼──────┐
                            │ Listeners  │
                            │ (dashboard,│
                            │  logging,  │
                            │  other     │
                            │  systems)  │
                            └────────────┘
```

### 3.3 MAP Integration — Sidecar with Fire-and-Forget Fallback

#### Sidecar mode (configurable)

The sidecar is a persistent Node.js process that maintains a WebSocket connection to the MAP server. Two lifecycle modes:

**`"session"` mode (default):**
- Started by the `SessionStart` hook as a background process
- Stopped by the `SessionEnd` hook (SIGTERM to PID)
- Self-terminates after inactivity timeout (30 min) as safety net
- Tied to the Claude Code session lifecycle
- **Best-effort auto-recovery:** if the sidecar crashes mid-session, the `UserPromptSubmit` hook detects the missing socket, restarts the sidecar, and re-registers agents. Messages received during the gap are lost, but the connection resumes for subsequent turns.

**`"persistent"` mode:**
- User starts the sidecar independently (e.g., as a daemon or in a separate terminal)
- Plugin hooks connect to it via UNIX socket — if it's running, use it; if not, fall back
- Survives across Claude Code sessions
- Useful for long-running projects with frequent session restarts

In both modes, the sidecar:
1. Connects to the MAP server via WebSocket
2. Registers as the agent's MAP identity (role + team name)
3. Joins the team's MAP scope
4. Listens for incoming messages, writes to inbox file
5. Accepts outbound messages via UNIX socket, forwards to MAP server

#### Sidecar ↔ hooks communication

```
┌──────────────┐                      ┌──────────────┐
│  Hook        │ ──── UNIX socket ──→ │  Sidecar     │
│  (short-     │ ←── file read ────── │  (long-      │
│   lived)     │                      │   running)   │
└──────────────┘                      └──────────────┘

Outbound: hook writes event JSON to sidecar via UNIX socket (.generated/map/sidecar.sock)
Inbound:  hook reads .generated/map/inbox.jsonl (written by sidecar)
```

#### Fire-and-forget fallback (outbound only)

If the sidecar isn't running, hooks fall back to one-shot WebSocket connections:

```javascript
// Pseudocode: hook fallback logic
const sidecarSocket = tryConnectLocal('.generated/map/sidecar.sock');
if (sidecarSocket) {
  // Fast path: send to sidecar via local socket
  sidecarSocket.write(JSON.stringify(event));
} else {
  // Slow path: direct MAP server connection (fire-and-forget)
  const agent = await AgentConnection.connect(config.map.server, {
    name: agentName,
    role: roleName,
    scopes: [teamScope]
  });
  await agent.send({ scope: teamScope }, event);
  await agent.disconnect();
}
```

~100-200ms overhead per event. No inbound capability. Acceptable for lifecycle events.

#### Best-effort sidecar auto-recovery

When the `UserPromptSubmit` hook detects the sidecar is not running (socket connection fails), it attempts recovery:

```
UserPromptSubmit hook fires
        │
        ├─ Try connect to .generated/map/sidecar.sock
        │
        ├─ [if socket exists and responds]
        │     Sidecar is healthy → read inbox, proceed normally
        │
        ├─ [if socket missing or connection refused]
        │     1. Check .generated/map/sidecar.pid — is process alive?
        │     2. If dead: restart sidecar (node scripts/map-sidecar.mjs &)
        │     3. Wait briefly for socket to appear (up to 2s)
        │     4. If recovery succeeds: re-register agents, proceed
        │     5. If recovery fails: log warning, fall back to fire-and-forget
        │
        └─ Read inbox (may be empty if sidecar was down)
```

Recovery is best-effort:
- Messages received by the MAP server while the sidecar was down are lost (MAP doesn't buffer for disconnected agents by default)
- Agent registrations are re-created, but any state (inbox, in-flight messages) from the crashed sidecar is gone
- The hook never blocks the agent's turn — if recovery takes too long, it falls back silently

### 3.4 Scope Model

**One MAP scope per swarm team.** When a swarm launches, all agents in that team share a MAP scope:

```
scope = "swarm:<team-name>"        // e.g., "swarm:get-shit-done"
agent = "<team-name>-<role>"       // e.g., "get-shit-done-orchestrator"
```

All agents register with their scope. MAP messages addressed to `{ scope: "swarm:get-shit-done" }` reach all team members.

Addressing options:
- `{ agent: "get-shit-done-executor" }` — direct to one agent
- `{ role: "executor", within: "swarm:get-shit-done" }` — all executors in this team
- `{ scope: "swarm:get-shit-done" }` — broadcast to entire team
- `{ parent: true }` — to spawning agent
- `{ children: true }` — to all spawned agents

### 3.5 Federation-Based Observability

MAP's federation layer provides a clean mechanism for broadcasting swarm events to external systems (dashboards, logging, other agent systems) without requiring them to connect to the same MAP server.

#### How federation works

The MAP server can establish federation connections with peer systems. When a federation peer is connected, events and messages are automatically wrapped in `FederationEnvelope` and forwarded:

```typescript
interface FederationEnvelope<T = unknown> {
  payload: T;                    // The message or event
  federation: {
    sourceSystem: string;        // "system-claude-swarm"
    targetSystem: string;        // "system-dashboard"
    hopCount: number;            // Loop prevention
    maxHops?: number;
    path?: string[];             // Systems traversed (debugging)
    originTimestamp: Timestamp;
    correlationId?: string;      // Cross-system tracing
  };
}
```

#### Configuration

The MAP server (user-provisioned) handles federation configuration. The swarm plugin just needs to know its own system identity:

```json
{
  "map": {
    "enabled": true,
    "server": "ws://localhost:8080",
    "systemId": "system-claude-swarm"
  }
}
```

The MAP server operator configures federation peers (dashboards, logging systems, other agent platforms) on the server side. The swarm plugin's sidecar connects as an agent — the server handles federation routing transparently.

#### What observers see

A federated observer (e.g., a dashboard on a different MAP system) receives:
1. **MAP-native events** — `agent_registered`, `agent_state_changed`, `message_sent` etc., wrapped in federation envelopes
2. **Custom swarm events** — `swarm.agent.spawned`, `swarm.task.dispatched` etc., as message payloads in federation envelopes
3. **Full routing metadata** — source system, hop path, correlation IDs for cross-system tracing

This means a dashboard doesn't need to know about Claude Code or hooks — it just subscribes to federation events from `system-claude-swarm` and gets a complete view of the swarm.

#### Federation vs direct subscription

| | Direct subscription | Federation |
|---|---|---|
| **Observer location** | Same MAP server | Any MAP system |
| **Setup** | `ClientConnection` to server | Federation peer config on server |
| **Latency** | Lowest (same process) | Slightly higher (cross-system) |
| **Isolation** | Observer sees everything | Can filter by system/scope |
| **Use case** | Local development dashboard | Multi-team observability, logging services |

Both work. Federation is the right choice when observers are on separate infrastructure or when you want to aggregate events from multiple swarm instances.

### 3.6 sessionlog Integration

**Fully independent.** sessionlog manages its own lifecycle — installation, hook registration, session tracking. The swarm plugin does NOT call `sessionlog enable` or install sessionlog.

The plugin's role is limited to:
1. **Check** — on `SessionStart`, verify if sessionlog is active and report status
2. **Warn** — if `sessionlog.enabled: true` in config but sessionlog isn't installed/active, output a warning
3. **Coexist** — the plugin's hooks and sessionlog's hooks run independently; Claude Code merges them

```
SessionStart hook output:
  "## Claude Code Swarm (openteams)
   Team template: get-shit-done
   MAP: connected (scope: swarm:get-shit-done)
   Sessionlog: ✓ active          ← or "⚠ not installed (optional)"
   Use /swarm to launch the team."
```

**What sessionlog provides for swarms:**
- Full session tracking across the orchestrator and all spawned agents (via its own `PreToolUse(Task)` / `PostToolUse(Task)` hooks)
- Token usage rollup across the entire agent tree
- File change aggregation
- Checkpoint/rewind — restore the project to before the swarm made changes
- Secret-redacted transcript storage for post-mortem

**What the user does:** Install and enable sessionlog independently:
```bash
npm install -g sessionlog
sessionlog enable --agent claude-code
```

---

## 4. MAP Event Model

### 4.1 Design principles

- **Observability first** — v1 focuses on making the swarm visible (what agents exist, what they're doing, when they spawn/complete)
- **Task events** — Claude Code native task lifecycle is surfaced as MAP events
- **Inter-agent messages** — agent-to-agent communication is observable by any MAP subscriber
- **Structured payloads** — events use typed payloads (not free-form text) so dashboards can parse them
- **MAP-native events are free** — `agent_registered`, `agent_state_changed`, `message_sent`, etc. are emitted by the MAP server automatically when agents register and send messages. We only need custom events for swarm-specific semantics.

### 4.2 Outbound events (hooks → MAP)

These are custom events emitted by the plugin's hooks. They supplement the MAP-native events with swarm-specific context.

#### Agent lifecycle events

Emitted via `PreToolUse(Task)` and `PostToolUse(Task)` hooks:

```typescript
// When orchestrator spawns an executor
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.agent.spawned",
    agent: "get-shit-done-executor",
    role: "executor",
    parent: "get-shit-done-orchestrator",
    task: "Implement authentication module"     // summary of the spawning prompt
  },
  meta: { relationship: "parent-to-child" }
}

// When executor completes
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.agent.completed",
    agent: "get-shit-done-executor",
    role: "executor",
    parent: "get-shit-done-orchestrator",
    filesTouched: ["src/auth.ts", "src/auth.test.ts"],
    durationMs: 45000
  },
  meta: { relationship: "child-to-parent" }
}
```

#### Turn lifecycle events

Emitted via `UserPromptSubmit` and `Stop` hooks:

```typescript
// Turn started
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.turn.started",
    agent: "get-shit-done-orchestrator",
    role: "orchestrator",
    promptLength: 150
  }
}

// Turn completed
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.turn.completed",
    agent: "get-shit-done-orchestrator",
    role: "orchestrator",
    stopReason: "end_turn"
  }
}
```

#### Task events

Emitted via `PreToolUse(Task)` and `PostToolUse(Task)`. These map to whatever task system is active — Claude Code's native `Agent` tool dispatches are the primary source. The event format is task-system-agnostic:

```typescript
// Task dispatched (orchestrator spawns a team agent for a task)
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.task.dispatched",
    taskId: "tool-use-id-abc123",         // Claude Code tool_use ID
    agent: "get-shit-done-orchestrator",  // dispatcher
    targetAgent: "get-shit-done-executor",
    targetRole: "executor",
    description: "Implement user login endpoint"
  }
}

// Task completed
{
  to: { scope: "swarm:get-shit-done" },
  payload: {
    type: "swarm.task.completed",
    taskId: "tool-use-id-abc123",
    agent: "get-shit-done-executor",
    parent: "get-shit-done-orchestrator",
    status: "completed",
    filesTouched: ["src/auth.ts", "src/auth.test.ts"]
  }
}
```

The `taskId` is the Claude Code `tool_use` ID from the hook's stdin data. This provides natural correlation between dispatch and completion without requiring a separate task tracking system.

### 4.3 Agent registration model

**Team-level agents get separate MAP registrations. Internal subagents do not.**

When the orchestrator spawns a team role (e.g., executor, planner, verifier), the sidecar registers a new MAP agent with parent/child relationship:

```typescript
// Sidecar receives PreToolUse(Task) event from hook
// The Task is spawning a team agent (name matches a role in the topology)
await connection.send(/* agents.register */, {
  agentId: "get-shit-done-executor",
  name: "executor",
  role: "executor",
  parent: "get-shit-done-orchestrator",
  scopes: ["swarm:get-shit-done"],
  metadata: { template: "get-shit-done", position: "spawned" }
});
```

When the team agent completes, the sidecar unregisters it:
```typescript
await connection.send(/* agents.unregister */, {
  agentId: "get-shit-done-executor",
  reason: "task completed"
});
```

**What counts as a "team agent":** Any agent spawned via the `Agent` tool whose name matches a role defined in the openteams topology (`team.yaml`). The sidecar checks the spawned agent's name against the team's role list.

**What does NOT get registered:** If a team agent (e.g., executor) internally spawns Claude Code subagents for its own use (e.g., a research subagent), those are internal to the executor and invisible to MAP. This keeps the MAP agent tree clean — it mirrors the team topology, not every Claude Code process.

This means a dashboard querying `agents.get("get-shit-done-orchestrator", { include: { descendants: true } })` sees:
```
orchestrator
├── planner
├── executor
├── verifier
└── researcher
```

Not:
```
orchestrator
├── planner
│   └── planner-internal-search-subagent    ← NOT registered
├── executor
│   ├── executor-internal-test-runner       ← NOT registered
│   └── executor-internal-linter            ← NOT registered
└── verifier
```

### 4.4 MAP-native events (free observability)

These are emitted automatically by the MAP server — no plugin work needed. A `ClientConnection` subscriber or federated observer sees:

| Event | When | Data |
|---|---|---|
| `agent_registered` | Sidecar registers agent | `{ agentId, name, role, scopes }` |
| `agent_state_changed` | Agent calls `updateState()` | `{ agentId, previousState, newState }` |
| `agent_unregistered` | Agent disconnects | `{ agentId, reason }` |
| `message_sent` | Any `send()` call | `{ messageId, from, to }` |
| `message_delivered` | Message reaches recipient | `{ messageId, deliveredTo }` |
| `scope_member_joined` | Agent joins scope | `{ scopeId, agentId }` |
| `scope_member_left` | Agent leaves scope | `{ scopeId, agentId }` |

Combined with our custom events, a dashboard gets a complete picture of the swarm without agents needing to do anything special.

### 4.5 Agent state mapping

The sidecar maps Claude Code session phases to MAP agent states:

| Claude Code Phase | MAP AgentState | When |
|---|---|---|
| Session started | `"active"` | `SessionStart` hook |
| Processing prompt | `"busy"` | `UserPromptSubmit` hook |
| Waiting for input | `"idle"` | `Stop` hook |
| Session ended | `"stopped"` | `SessionEnd` hook |
| Spawning subagent | (child registered as `"active"`) | `PreToolUse(Task)` |
| Subagent done | (child state → `"stopped"`) | `PostToolUse(Task)` |

### 4.6 Inbound messages (MAP → agent context)

When the sidecar receives messages addressed to this agent, it queues them in `.generated/map/inbox.jsonl`. The `UserPromptSubmit` hook reads the inbox and injects them as context.

**Injected format (structured markdown):**

```markdown
## [MAP] 2 pending messages

**From get-shit-done-verifier** (role: verifier, 3s ago)
> Module A verification failed. 3 test failures in src/auth.test.ts.
> Priority: high

**From get-shit-done-planner** (role: planner, 8s ago)
> Task 4 is ready for execution. Files: src/db.ts, src/models/user.ts
> Correlation: task-4-impl
```

This format is:
- Readable by LLMs (structured markdown, not raw JSON)
- Includes metadata (sender role, age, priority) without overwhelming
- Actionable — the agent can respond by sending messages back via MAP

---

## 5. Hook Ordering

### 5.1 Design principle

**The swarm plugin controls its own hook ordering. sessionlog controls its own.** They run independently. The plugin does not call sessionlog's CLI or manage its hooks.

Claude Code merges hooks from multiple sources:
- Plugin hooks (`hooks/hooks.json`) — the swarm plugin's hooks
- Project hooks (`.claude/settings.json`) — sessionlog's hooks (and any user hooks)

The plugin's `SessionStart` hook checks sessionlog status but doesn't depend on sessionlog running first. sessionlog is resilient to ordering — its `SessionStart` hook is idempotent.

### 5.2 Plugin hook ordering (within `hooks/hooks.json`)

The plugin's own hooks execute in declaration order:

#### SessionStart

```
1. Read .claude-swarm.json (config)
2. Ensure openteams is installed
3. Check sessionlog status (report, don't manage)
4. [if map.enabled] Start sidecar (session mode) or verify sidecar running (persistent mode)
5. Output team context + status to stdout (injected into conversation)
```

#### UserPromptSubmit

```
1. [if map.enabled] Read .generated/map/inbox.jsonl
2. Format pending messages as structured markdown
3. Clear processed messages from inbox
4. Output to stdout (injected into agent's turn context)
```

#### PreToolUse (matcher: "Task")

```
1. [if map.enabled] Emit swarm.agent.spawned event
2. [if map.enabled] Emit swarm.task.dispatched event
```

#### PostToolUse (matcher: "Task")

```
1. [if map.enabled] Emit swarm.agent.completed event
2. [if map.enabled] Emit swarm.task.completed event
```

#### Stop

```
1. [if map.enabled] Emit swarm.turn.completed event
2. [if map.enabled] Update agent state to "idle"
```

#### SessionEnd

```
1. [if map.enabled, session mode] Send SIGTERM to sidecar PID
2. [if map.enabled] Update agent state to "stopped"
```

### 5.3 No ordering dependency on sessionlog

sessionlog's hooks run in whatever order Claude Code assigns them. The swarm plugin neither depends on nor interferes with sessionlog's execution. If sessionlog isn't installed, the swarm plugin works identically — it just reports "sessionlog: not installed" in the context output.

---

## 6. Configuration Schema

### `.claude-swarm.json`

```json
{
  "template": "get-shit-done",

  "map": {
    "enabled": true,
    "server": "ws://localhost:8080",
    "scope": "my-project-swarm",
    "systemId": "system-claude-swarm",
    "sidecar": "session"
  },

  "sessionlog": {
    "enabled": true
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `template` | `string` | — | Team topology name or path (required) |
| `map.enabled` | `boolean` | `false` | Enable MAP integration |
| `map.server` | `string` | `"ws://localhost:8080"` | MAP server WebSocket URL (must be running) |
| `map.scope` | `string` | `"swarm:<template>"` | MAP scope for this team (auto-derived if omitted) |
| `map.systemId` | `string` | `"system-claude-swarm"` | Federation system identity for this swarm instance |
| `map.sidecar` | `"session" \| "persistent"` | `"session"` | Sidecar lifecycle mode |
| `sessionlog.enabled` | `boolean` | `false` | Check for sessionlog and report status |

### Minimal config (no integrations)

```json
{ "template": "get-shit-done" }
```

### Full config

```json
{
  "template": "get-shit-done",
  "map": {
    "enabled": true,
    "server": "ws://localhost:8080",
    "systemId": "my-project-swarm",
    "sidecar": "session"
  },
  "sessionlog": {
    "enabled": true
  }
}
```

---

## 7. File Changes

### New files

| File | Purpose |
|---|---|
| `scripts/map-sidecar.mjs` | MAP sidecar process — persistent WebSocket, inbox/outbox, agent registration |
| `scripts/map-hook.mjs` | MAP hook helper — inbox injection, event emission, fallback logic |
| `scripts/bootstrap.sh` | Unified SessionStart entry point — openteams, MAP, sessionlog status |
| `docs/design.md` | This document |

### Modified files

| File | Change |
|---|---|
| `hooks/hooks.json` | Replace inline SessionStart; add `UserPromptSubmit`, `PreToolUse(Task)`, `PostToolUse(Task)`, `Stop`, `SessionEnd` hooks |
| `settings.json` | Add `Bash(node *)` permission for sidecar/hooks |
| `scripts/generate-agents.mjs` | Replace openteams messaging section with MAP coordination in generated AGENT.md; add scope/addressing info |
| `skills/swarm/SKILL.md` | Document MAP and sessionlog in the launch flow |
| `CLAUDE.md` | Update architecture description |

### Generated files (in `.generated/`, gitignored)

| File | Purpose |
|---|---|
| `.generated/map/inbox.jsonl` | Queued inbound MAP messages |
| `.generated/map/sidecar.pid` | Sidecar process PID (session mode) |
| `.generated/map/sidecar.sock` | UNIX socket for hook ↔ sidecar communication |

---

## 8. Detailed Flows

### 8.1 Session Start (full flow)

```
Claude Code starts session
        │
        ▼
SessionStart hook fires (hooks/hooks.json)
        │
        ▼
scripts/bootstrap.sh
        │
        ├─ 1. Read .claude-swarm.json
        │     Parse template, map, sessionlog config
        │
        ├─ 2. Install openteams (if needed)
        │     command -v openteams || npm install -g openteams
        │
        ├─ 3. [if sessionlog.enabled]
        │     Check: command -v sessionlog && sessionlog status
        │     Report status (do NOT install or enable)
        │     Warn if not active: "sessionlog configured but not installed"
        │
        ├─ 4. [if map.enabled]
        │     4a. [sidecar=session]
        │         node scripts/map-sidecar.mjs \
        │           --server ws://localhost:8080 \
        │           --scope swarm:get-shit-done \
        │           --agent get-shit-done-orchestrator \
        │           --role orchestrator &
        │         Write PID to .generated/map/sidecar.pid
        │     4b. [sidecar=persistent]
        │         Check if sidecar is running via .generated/map/sidecar.sock
        │         Warn if not running
        │
        └─ 5. Output to stdout (injected as context):
              "## Claude Code Swarm (openteams)
               Team template: get-shit-done
               MAP: connected (scope: swarm:get-shit-done)
               Sessionlog: ✓ active
               Use /swarm to launch the team."
```

### 8.2 MAP Message Flow (inbound)

```
External agent sends MAP message
        │
        ▼
MAP Server routes to { agent: "gsd-executor" }
        │
        ▼
Sidecar receives via WebSocket (onMessage handler)
        │
        ▼
Sidecar appends to .generated/map/inbox.jsonl:
  {"id":"01HX...","from":"gsd-planner","to":{"agent":"gsd-executor"},
   "timestamp":"2026-03-01T10:30:45Z",
   "payload":{"type":"task.ready","taskId":"4","files":["src/db.ts"]},
   "meta":{"priority":"high"}}
        │
        ▼
[Next turn: user submits prompt or orchestrator dispatches]
        │
        ▼
UserPromptSubmit hook fires
        │
        ▼
scripts/map-hook.mjs --action inject
        │
        ├─ Read .generated/map/inbox.jsonl
        ├─ Format as structured markdown
        ├─ Truncate inbox (clear processed messages)
        └─ Output to stdout:
            "## [MAP] 1 pending message
             **From gsd-planner** (role: planner, 3s ago)
             > Task 4 is ready. Files: src/db.ts
             > Priority: high"
        │
        ▼
Agent sees MAP messages as part of its turn context
```

### 8.3 MAP Event Flow (outbound)

```
Agent spawns a subagent (PreToolUse: Task)
        │
        ▼
PreToolUse(Task) hook fires (hooks/hooks.json)
        │
        ▼
scripts/map-hook.mjs --action emit
  Receives on stdin: { tool_name: "Task", tool_input: { name: "executor", prompt: "..." } }
        │
        ├─ [if sidecar running]
        │     Connect to .generated/map/sidecar.sock
        │     Send: { type: "swarm.agent.spawned", agent: "gsd-executor", ... }
        │     Sidecar forwards to MAP server
        │
        └─ [if sidecar not running — fallback]
              AgentConnection.connect(config.map.server, { name: agentName })
              agent.send({ scope: teamScope }, { type: "swarm.agent.spawned", ... })
              agent.disconnect()
```

### 8.4 Dashboard / Observer View

#### Option A: Direct subscription (same MAP server)

A MAP `ClientConnection` can subscribe to the team scope and see the full swarm:

```typescript
import { ClientConnection, websocketStream, EVENT_TYPES } from '@multi-agent-protocol/sdk';

const client = new ClientConnection(websocketStream(ws));
await client.connect();

// Subscribe to all events in the swarm scope
const sub = await client.subscribe({
  scopes: ["swarm:get-shit-done"],
  eventTypes: [
    EVENT_TYPES.AGENT_REGISTERED,
    EVENT_TYPES.AGENT_STATE_CHANGED,
    EVENT_TYPES.MESSAGE_SENT,
    EVENT_TYPES.MESSAGE_DELIVERED
  ]
});

sub.onEvent((event) => {
  // See: agent registered, state changes, all messages, task events
  console.log(`[${event.type}]`, event.data);
});

// Also receive custom swarm events via message subscription
client.onMessage((msg) => {
  // See: swarm.agent.spawned, swarm.task.dispatched, etc.
  console.log(`[${msg.payload?.type}]`, msg.payload);
});
```

#### Option B: Federation (separate MAP system)

A dashboard running on a different MAP system receives events via federation. The MAP server forwards all scope events wrapped in `FederationEnvelope`:

```typescript
// Dashboard on a separate MAP system
// Server-side: federation peer configured to accept from "system-claude-swarm"

// Dashboard subscribes to federation events
const sub = await client.subscribe({
  eventTypes: [
    EVENT_TYPES.FEDERATION_CONNECTED,
    EVENT_TYPES.AGENT_REGISTERED,      // forwarded from swarm system
    EVENT_TYPES.AGENT_STATE_CHANGED,   // forwarded from swarm system
    EVENT_TYPES.MESSAGE_SENT           // forwarded from swarm system
  ]
});

// Events arrive with federation metadata for cross-system tracing
sub.onEvent((event) => {
  // event.data may include federation.sourceSystem = "system-claude-swarm"
  console.log(`[federated:${event.type}]`, event.data);
});
```

This is especially useful for:
- **Multi-team observability** — aggregate events from multiple swarm instances on different machines
- **Logging services** — forward swarm events to a centralized logging/monitoring system
- **Cross-platform coordination** — a dashboard system that monitors both Claude Code swarms and other agent platforms

---

## 9. Open Questions

### ~~9.1 Sidecar crash recovery~~ (RESOLVED)

**Decision:** Best-effort auto-recovery. The `UserPromptSubmit` hook detects missing sidecar and restarts it. Messages during the gap are lost. See section 3.3 "Best-effort sidecar auto-recovery" for details.

### 9.2 Multiple concurrent swarms

**Q:** What happens if a user launches two swarm teams in the same session?

**Leaning:** Not supported in v1. Each session has one `.claude-swarm.json` config and one MAP scope. Document this limitation.

### 9.3 Hook merge ordering guarantees

**Q:** Does Claude Code guarantee plugin hooks run before or after project hooks?

**Current approach:** We don't depend on ordering between our hooks and sessionlog's hooks. Our hooks are self-contained. Test empirically to verify no conflicts.

### ~~9.4 Subagent MAP registration~~ (RESOLVED)

**Decision:** Team-level agents (roles from the openteams topology) get separate MAP registrations with parent/child relationships. Internal subagents spawned by a team agent do NOT get registered. See section 4.3 for details.

### ~~9.5 openteams task events vs MAP task events~~ (RESOLVED)

**Decision:** MAP task events map to whatever task system is in play. The primary source is Claude Code native task events (agent spawning via the `Agent` tool). openteams task CLI (`openteams task create/update`) is not monitored for MAP events — it's an internal coordination mechanism. MAP provides the observability layer; openteams provides the structural definitions.

### ~~9.6 Federation configuration ownership~~ (RESOLVED)

**Decision:** Server operator configures federation peers. The plugin just connects as an agent. The `map.systemId` config field identifies this swarm instance for federation envelope routing.

### ~~9.7 Sidecar agent identity when multiple team agents are spawned~~ (RESOLVED)

**Decision:** Single connection. The sidecar uses one `AgentConnection` and calls `agents.register()` / `agents.spawn()` to create child agents on behalf of the team.

---

## 10. Implementation Phases

### Phase 1: Foundation

- [ ] Create `scripts/bootstrap.sh` — unified SessionStart entry point
- [ ] Update `hooks/hooks.json` to use bootstrap script
- [ ] Add sessionlog status check (not lifecycle management)
- [ ] Update `.claude-swarm.json` schema with `map` and `sessionlog` fields
- [ ] Update `settings.json` permissions
- [ ] Update `scripts/generate-agents.mjs` to drop openteams messaging, add MAP context

### Phase 2: MAP Sidecar + Outbound Events

- [ ] Create `scripts/map-sidecar.mjs` — persistent WebSocket, agent registration, inbox/outbox
- [ ] Create `scripts/map-hook.mjs` — event emission with sidecar/fallback logic
- [ ] Add `PreToolUse(Task)`, `PostToolUse(Task)`, `Stop`, `SessionEnd` hooks
- [ ] Implement sidecar lifecycle (session + persistent modes)
- [ ] Test with a local MAP server + `ClientConnection` subscriber

### Phase 3: MAP Inbound + Recovery

- [ ] Add `UserPromptSubmit` hook for MAP inbox injection
- [ ] Implement inbox formatting (structured markdown)
- [ ] Implement best-effort sidecar auto-recovery in `UserPromptSubmit` hook
- [ ] Test end-to-end: external sender → sidecar inbox → hook injection → agent sees message
- [ ] Test recovery: kill sidecar mid-session → next prompt restarts it

### Phase 4: Team Agent Registration

- [ ] Sidecar registers team-level agents on `PreToolUse(Task)` when name matches topology role
- [ ] Sidecar unregisters team agents on `PostToolUse(Task)` completion
- [ ] Ignore internal subagents (names not matching topology roles)
- [ ] MAP server tracks team agent tree (parent/child relationships)
- [ ] Dashboard can query `agents.get(orchestratorId, { include: { descendants: true } })`

### Phase 5: Polish

- [ ] Update `/swarm` SKILL.md with MAP/sessionlog documentation
- [ ] Update CLAUDE.md with new architecture
- [ ] Error handling: MAP server down, sidecar crash, malformed messages
- [ ] Agent state transitions (active → busy → idle → stopped)
- [ ] Verify federation event forwarding works with federated observers

---

## 11. Dependencies

| Package | Purpose | Install method | Required? |
|---|---|---|---|
| `openteams` | Team topologies, task CLI | `npm install -g openteams` | Yes |
| `sessionlog` | Session tracking, checkpointing | User installs independently | Only if `sessionlog.enabled` |
| `@multi-agent-protocol/sdk` | MAP connections, messaging | `npm install -g @multi-agent-protocol/sdk` | Only if `map.enabled` |

openteams is installed on-demand by `scripts/bootstrap.sh`. sessionlog is user-managed. MAP SDK is installed on-demand when MAP is enabled. The plugin itself has zero bundled npm dependencies.
