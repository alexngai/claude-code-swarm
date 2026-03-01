# claude-code-swarm — Integration Design

Design document for integrating MAP (Multi-Agent Protocol) and sessionlog into the claude-code-swarm plugin.

## Status

**Draft** — iterating on architecture and scope.

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

1. **MAP** — Real-time agent-to-agent communication protocol, with observability and coordination
2. **sessionlog** — Session tracking, checkpointing, and rewind capability

Both are opt-in via `.claude-swarm.json` configuration.

---

## 2. Systems Overview

### 2.1 MAP (Multi-Agent Protocol)

**Package:** `@multi-agent-protocol/sdk` (npm)

MAP provides structured agent-to-agent messaging with:
- **MAPServer** — central message router
- **AgentConnection** — per-agent connection (register, send, receive)
- **ClientConnection** — for dashboards/observers
- **Addressing** — `{ agent }`, `{ role }`, `{ scope }`, `{ children }`, `{ parent }`, `{ agents: [] }`
- **Transports** — WebSocket (`websocketStream`), stdio (`ndJsonStream`), in-process (`createStreamPair`)
- **Wire format** — NDJSON

MAP also has a Mail system (conversations, threads, turns) for structured dialogue — a v2 concern.

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

sessionlog installs 7 Claude Code hooks programmatically into `.claude/settings.json`:
- `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`
- `PreToolUse(Task)`, `PostToolUse(Task)` — subagent lifecycle
- `PostToolUse(TodoWrite)` — compaction events

And 4 git hooks: `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-push`.

### 2.3 openteams (existing)

**Package:** `openteams` (npm)

openteams provides team topology templates and coordination primitives:
- **Templates** — YAML topology definitions with roles, spawn rules, communication channels
- **Task management** — `openteams task list/create/update`
- **Messaging** — `openteams message send/poll`
- **Signals** — `openteams template emit/events` (channel-based pub/sub)

Agents interact with openteams entirely via CLI commands in Bash tool calls.

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
    │ sessionlog│     │  context │    │            │
    │ enable)   │     └────┬─────┘    └─────┬──────┘
    └─────┬─────┘          │                │
          │           ┌────▼────────────────▼──────┐
          │           │      MAP Sidecar           │
          ▼           │  (persistent WebSocket)    │
    ┌───────────┐     │                            │
    │ sessionlog│     │  inbox/  ← received msgs   │
    │ (tracks   │     │  outbox/ → sent events     │
    │  session) │     └────────────┬───────────────┘
    └───────────┘                  │
                             ┌─────▼──────┐
                             │ MAP Server │
                             └────────────┘
```

### 3.3 MAP Integration — Sidecar with Fire-and-Forget Fallback

#### Sidecar model (preferred — bidirectional)

A persistent Node.js process runs alongside the Claude Code session:

1. **Started by** the `SessionStart` hook
2. **Connects to** the MAP server via WebSocket
3. **Registers** as the agent's MAP identity (role name from topology)
4. **Listens** for incoming MAP messages
5. **Writes** received messages to a local inbox file (`.generated/map/inbox.jsonl`)
6. **Accepts** outbound messages via a local mechanism (UNIX socket or file watch on `.generated/map/outbox.jsonl`)

The `UserPromptSubmit` hook reads `.generated/map/inbox.jsonl`, formats pending messages, and outputs them to stdout — injecting them as context for the agent's next turn.

```
Agent Turn N:
  1. User submits prompt (or orchestrator dispatches task)
  2. UserPromptSubmit hook fires
  3. Hook reads .generated/map/inbox.jsonl
  4. Hook outputs: "[MAP] 2 messages received:\n  - from:planner: Task 3 ready for execution\n  - from:verifier: Module A passed verification"
  5. Agent sees these messages as part of its context
  6. Agent acts on messages, potentially sending responses via openteams or MAP outbox
```

#### Fire-and-forget fallback (outbound only)

If the sidecar isn't running (startup failed, MAP server unavailable), hooks fall back to one-shot connections:

1. Each hook invocation that needs to emit a MAP event opens a WebSocket, sends, closes
2. ~100-200ms overhead per hook — acceptable for session lifecycle events
3. No inbound capability — agent only emits, cannot receive
4. Graceful degradation — hooks check for sidecar PID file first, fall back silently

```javascript
// Pseudocode: hook fallback logic
const sidecarSocket = tryConnectLocal('.generated/map/sidecar.sock');
if (sidecarSocket) {
  // Fast path: send to sidecar via local socket
  sidecarSocket.write(JSON.stringify(event));
} else {
  // Slow path: direct MAP server connection (fire-and-forget)
  const ws = new WebSocket(config.map.server);
  const stream = websocketStream(ws);
  const agent = new AgentConnection(stream, { name: roleName, role: roleName });
  await agent.connect();
  await agent.send({ to: { scope: teamScope }, payload: event });
  await agent.disconnect();
}
```

#### Why not openteams message poll for inbound?

openteams has `openteams message poll` which agents can call in Bash. The generated AGENT.md files already include polling instructions. However:

- **No push mechanism** — agents only poll when their instructions tell them to, and only when actively running
- **Latency** — polling is O(seconds) at best; MAP delivery is O(milliseconds)
- **No guaranteed delivery** — if an agent doesn't poll, messages sit indefinitely
- **Cross-turn blindness** — between turns, the agent isn't running and can't poll

The MAP sidecar solves all of these: it maintains a persistent connection, queues messages instantly, and the hook injection ensures the agent sees them at the start of every turn.

**openteams messaging remains useful** for structured task coordination (task lifecycle, signal emission). MAP handles the real-time transport layer underneath. A future version of openteams could use MAP as its transport, but that's an openteams-level change, not a plugin change.

### 3.4 Scope Model

**One MAP scope per swarm team.** When a swarm launches, all agents in that team share a MAP scope derived from the team name:

```
scope = "swarm:<team-name>"
```

For example, a `get-shit-done` launch creates scope `swarm:get-shit-done`. All 12 agents register under this scope. MAP messages addressed to `{ scope: "swarm:get-shit-done" }` reach all team members.

Individual addressing uses `{ agent: "<team>-<role>" }` (matching the AGENT.md `name` field, e.g., `get-shit-done-orchestrator`).

Role-based addressing uses `{ role: "<role>" }` for cases where multiple agents share a role.

### 3.5 sessionlog Integration

**Opt-in via config.** sessionlog is enabled only when explicitly configured in `.claude-swarm.json`:

```json
{
  "template": "get-shit-done",
  "sessionlog": {
    "enabled": true
  }
}
```

When enabled, the `SessionStart` hook runs:

```bash
command -v sessionlog >/dev/null 2>&1 && sessionlog enable --agent claude-code 2>/dev/null || true
```

This is idempotent — sessionlog's `enable()` checks if hooks are already installed and skips. It writes its hooks to `.claude/settings.json` (project-level), which Claude Code merges with plugin hooks from `hooks/hooks.json`.

**What sessionlog provides for swarms:**
- Full session tracking across the orchestrator and all spawned agents (via `PreToolUse(Task)` / `PostToolUse(Task)` hooks)
- Token usage rollup across the entire agent tree (`calculateTotalTokenUsage`)
- File change aggregation (`extractAllModifiedFiles`)
- Checkpoint/rewind — restore the project to a state before the swarm made changes
- Secret-redacted transcript storage for post-mortem analysis

**What we don't need to build:** sessionlog already handles subagent tracking natively. No per-agent sessionlog configuration is needed.

---

## 4. Hook Ordering

Hook execution order matters. Claude Code runs hooks in declaration order within each event type. The plugin's hooks (from `hooks/hooks.json`) and sessionlog's hooks (from `.claude/settings.json`) are merged by Claude Code.

### 4.1 Desired Execution Order

#### SessionStart

| Order | Source | Action | Rationale |
|---|---|---|---|
| 1 | sessionlog | `session-start` — establish tracking baseline | Must be first so the entire session is tracked, including swarm bootstrap |
| 2 | swarm plugin | Install openteams, load team config, output team context | Core plugin functionality |
| 3 | swarm plugin (MAP) | Start MAP sidecar, register agent | Sidecar must start after team config is known |

#### UserPromptSubmit

| Order | Source | Action | Rationale |
|---|---|---|---|
| 1 | sessionlog | `user-prompt-submit` — record turn start | Track before any modifications |
| 2 | swarm plugin (MAP) | Read MAP inbox, inject messages as context | Agent sees coordination messages before processing prompt |

#### Stop / PostToolUse

| Order | Source | Action | Rationale |
|---|---|---|---|
| 1 | swarm plugin (MAP) | Emit MAP event (turn completed, tool result) | Report to MAP server |
| 2 | sessionlog | `stop` / `post-task` — update session state | Track after swarm events are emitted |

### 4.2 Implementation Strategy

Since sessionlog installs its hooks via `.claude/settings.json` and the swarm plugin uses `hooks/hooks.json`, we need to control ordering:

**Option A: Have the swarm's SessionStart hook call sessionlog directly** instead of relying on sessionlog's self-installed hooks. This gives us explicit control over ordering. Downside: we're managing sessionlog's lifecycle, which couples the two.

**Option B: Rely on Claude Code's merge order** (plugin hooks before project hooks, or vice versa). This requires understanding and depending on Claude Code's undocumented merge behavior. Fragile.

**Option C (recommended): Use a single entry-point script** that orchestrates all three systems in sequence. The `SessionStart` hook in `hooks/hooks.json` calls a script that:
1. Enables sessionlog (if configured)
2. Loads team config and installs openteams
3. Starts MAP sidecar (if configured)
4. Outputs combined context to stdout

For `UserPromptSubmit`, add a new hook entry in `hooks/hooks.json` that:
1. Reads MAP inbox and outputs injected context
2. (sessionlog's own `user-prompt-submit` hook runs independently)

This approach gives us explicit control over our own ordering while letting sessionlog manage its own hooks independently. The only ordering dependency is that sessionlog's `SessionStart` hook runs before ours — which we solve by calling `sessionlog enable` as the first step in our own `SessionStart` hook.

---

## 5. Configuration Schema

### `.claude-swarm.json`

```json
{
  "template": "get-shit-done",

  "map": {
    "enabled": true,
    "server": "ws://localhost:8080",
    "scope": "my-project-swarm"
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
| `map.server` | `string` | `"ws://localhost:8080"` | MAP server WebSocket URL |
| `map.scope` | `string` | `"swarm:<template>"` | MAP scope for this team (auto-derived if omitted) |
| `sessionlog.enabled` | `boolean` | `false` | Enable sessionlog session tracking |

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
    "server": "ws://localhost:8080"
  },
  "sessionlog": {
    "enabled": true
  }
}
```

---

## 6. File Changes

### New files

| File | Purpose |
|---|---|
| `scripts/map-sidecar.mjs` | MAP sidecar process — persistent WebSocket, inbox/outbox management |
| `scripts/map-hook.mjs` | MAP hook helper — reads inbox for injection, emits events (fire-and-forget fallback) |
| `scripts/bootstrap.sh` | Unified SessionStart entry point — orchestrates sessionlog, openteams, and MAP |
| `docs/design.md` | This document |

### Modified files

| File | Change |
|---|---|
| `hooks/hooks.json` | Replace inline SessionStart command with `bootstrap.sh`; add `UserPromptSubmit` hook for MAP inbox injection |
| `settings.json` | Add `Bash(sessionlog *)` permission; add `Bash(node *)` for sidecar |
| `scripts/generate-agents.mjs` | Add MAP coordination section to generated AGENT.md files (scope, addressing) |
| `skills/swarm/SKILL.md` | Document MAP and sessionlog in the launch flow |
| `CLAUDE.md` | Update architecture description |

### Generated files (in `.generated/`, gitignored)

| File | Purpose |
|---|---|
| `.generated/map/inbox.jsonl` | Queued inbound MAP messages |
| `.generated/map/outbox.jsonl` | Pending outbound MAP messages (for sidecar) |
| `.generated/map/sidecar.pid` | Sidecar process PID |
| `.generated/map/sidecar.sock` | UNIX socket for local communication |

---

## 7. Detailed Flows

### 7.1 Session Start (full flow)

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
        ├─ 2. [if sessionlog.enabled]
        │     npm ls -g sessionlog || npm install -g sessionlog
        │     sessionlog enable --agent claude-code
        │     # sessionlog now has its own hooks in .claude/settings.json
        │
        ├─ 3. Install openteams (if needed)
        │     command -v openteams || npm install -g openteams
        │
        ├─ 4. [if map.enabled]
        │     npm ls -g @multi-agent-protocol/sdk || npm install -g @multi-agent-protocol/sdk
        │     Start sidecar: node scripts/map-sidecar.mjs &
        │     Write PID to .generated/map/sidecar.pid
        │
        └─ 5. Output to stdout (injected as context):
              "## Claude Code Swarm (openteams)
               Team template: get-shit-done
               MAP: connected (ws://localhost:8080, scope: swarm:get-shit-done)
               Sessionlog: enabled
               Use /swarm to launch the team."
```

### 7.2 MAP Message Flow (inbound)

```
External agent or orchestrator sends MAP message
        │
        ▼
MAP Server routes to scope/agent
        │
        ▼
Sidecar receives message via WebSocket
        │
        ▼
Sidecar writes to .generated/map/inbox.jsonl:
  {"from":"planner","to":{"agent":"gsd-executor"},"payload":{...},"ts":"..."}
        │
        ▼
[Next user turn or orchestrator dispatch]
        │
        ▼
UserPromptSubmit hook fires
        │
        ▼
scripts/map-hook.mjs reads inbox.jsonl
        │
        ├─ Formats messages as context text
        ├─ Clears processed messages from inbox
        └─ Outputs to stdout:
            "[MAP] 1 pending message:
             From planner: Task 3 is ready. Files: src/auth.ts, src/db.ts
             Priority: high"
        │
        ▼
Agent sees MAP messages as part of its turn context
```

### 7.3 MAP Message Flow (outbound)

```
Agent completes a tool use or turn
        │
        ▼
PostToolUse or Stop hook fires
        │
        ▼
scripts/map-hook.mjs
        │
        ├─ [if sidecar running]
        │     Write event to sidecar via UNIX socket
        │     Sidecar sends to MAP server
        │
        └─ [if sidecar not running — fallback]
              Direct WebSocket to MAP server
              Open, send, close (~100-200ms)
```

### 7.4 Session with sessionlog

```
Session starts → sessionlog tracks via its own hooks
        │
Agent tree: orchestrator spawns planner, executor, verifier
        │
sessionlog's PreToolUse(Task) / PostToolUse(Task) hooks
automatically track each subagent spawn/completion
        │
User commits code → git hooks fire:
  prepare-commit-msg: adds Sessionlog-Checkpoint trailer
  post-commit: writes committed checkpoint with redacted transcript
        │
If something goes wrong:
  sessionlog rewind → restores to pre-swarm state
```

---

## 8. Open Questions

### 8.1 Sidecar lifecycle management

**Q:** How do we ensure the sidecar is cleaned up when the session ends?

**Options:**
- A. `SessionEnd` hook sends SIGTERM to sidecar PID
- B. Sidecar self-terminates after inactivity timeout (e.g., 30 minutes)
- C. Both — hook cleanup + timeout safety net

**Leaning:** C — belt and suspenders.

### 8.2 MAP server provisioning

**Q:** Who runs the MAP server? Is it the user's responsibility, or does the plugin start one?

**Options:**
- A. User provides server URL in config — plugin connects only
- B. Plugin auto-starts a local MAP server if none configured
- C. Both — auto-start local server by default, configurable remote server

**Leaning:** A for v1 — keep scope small. User runs `npx @multi-agent-protocol/server` or similar. B is a v2 enhancement.

### 8.3 MAP message format for injected context

**Q:** How should MAP messages be formatted when injected via `UserPromptSubmit`?

**Options:**
- A. Plain text summary (human-readable)
- B. Structured markdown with metadata
- C. JSON block that the agent can parse

**Leaning:** B — structured but readable. Agents are LLMs, not JSON parsers.

### 8.4 Interaction between openteams messaging and MAP messaging

**Q:** Should MAP replace openteams messaging, augment it, or run independently?

**Current thinking:** They serve different purposes:
- **openteams messaging** — structured task coordination (task lifecycle, signals, team-scoped operations). Agents invoke via CLI.
- **MAP messaging** — real-time transport layer for observability and cross-agent notifications. Handled by hooks/sidecar.

For v1, they run independently. For v2, openteams could use MAP as its transport backend (an openteams-level change).

### 8.5 Multiple concurrent swarms

**Q:** What happens if a user launches two swarm teams in the same session?

**Leaning:** Not supported in v1. Each session has one `.claude-swarm.json` config and one MAP scope. Multiple teams would need separate MAP scopes and separate sidecars — add complexity later if needed.

### 8.6 Hook merge ordering guarantees

**Q:** Does Claude Code guarantee that plugin hooks (hooks/hooks.json) run before project hooks (.claude/settings.json), or vice versa?

**Action needed:** Test empirically or check Claude Code documentation. The Option C design in section 4.2 minimizes this dependency by having the swarm plugin call sessionlog directly rather than relying on merge order.

---

## 9. Implementation Phases

### Phase 1: Foundation

- [ ] Create `scripts/bootstrap.sh` — unified SessionStart entry point
- [ ] Update `hooks/hooks.json` to use bootstrap script
- [ ] Add sessionlog opt-in logic (check config, enable if present)
- [ ] Update `.claude-swarm.json` schema with `map` and `sessionlog` fields
- [ ] Update `settings.json` permissions

### Phase 2: MAP Outbound (observability)

- [ ] Create `scripts/map-hook.mjs` — fire-and-forget MAP event emitter
- [ ] Add `PostToolUse` and `Stop` hooks for MAP event emission
- [ ] Test with a local MAP server + client dashboard

### Phase 3: MAP Sidecar (bidirectional)

- [ ] Create `scripts/map-sidecar.mjs` — persistent WebSocket process
- [ ] Add `UserPromptSubmit` hook for MAP inbox injection
- [ ] Implement sidecar lifecycle (start on SessionStart, stop on SessionEnd)
- [ ] Implement fallback detection (sidecar running? → use socket; else → fire-and-forget)

### Phase 4: Agent-level MAP integration

- [ ] Update `scripts/generate-agents.mjs` to add MAP context to AGENT.md files
- [ ] Add MAP addressing info (scope, agent name) to generated agents
- [ ] Test end-to-end: orchestrator dispatches task → executor receives via MAP → executor reports completion via MAP

### Phase 5: Polish

- [ ] Update `/swarm` SKILL.md with MAP/sessionlog documentation
- [ ] Update CLAUDE.md with new architecture
- [ ] Error handling and edge cases (MAP server down, sidecar crash, etc.)
- [ ] Cleanup: SessionEnd hook tears down sidecar

---

## 10. Dependencies

| Package | Purpose | Install method | Required? |
|---|---|---|---|
| `openteams` | Team topologies, coordination CLI | `npm install -g openteams` | Yes |
| `sessionlog` | Session tracking, checkpointing | `npm install -g sessionlog` | Only if `sessionlog.enabled` |
| `@multi-agent-protocol/sdk` | MAP agent connections | `npm install -g @multi-agent-protocol/sdk` | Only if `map.enabled` |

All are installed on-demand by `scripts/bootstrap.sh`. The plugin itself has zero bundled npm dependencies.
