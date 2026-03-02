# Refactor: Replace custom `swarm.*` events with MAP SDK primitives

## Goal

Eliminate all custom `swarm.*` event types by using the MAP SDK's built-in `AgentConnection` methods (`spawn()`, `done()`, `updateState()`, `updateMetadata()`, `send()`) and the server's automatic event emission (`agent_registered`, `agent_state_changed`, etc.). This means MAP clients only need to subscribe to standard MAP event types — zero swarm-specific integration.

## Guiding principle

**No new message types.** All swarm-specific context goes into `metadata` on agents and `payload` on messages — never into custom event type strings.

---

## Current state → Target state mapping

| Current custom event | Target SDK primitive | Auto server event |
|---|---|---|
| `swarm.agent.registered` (sidecar broadcasts) | `conn.spawn({ name, role, parent, scopes, metadata })` | `agent_registered` |
| `swarm.agent.unregistered` (sidecar broadcasts) | `spawnedAgent.done({ exitReason })` or sidecar tracks + calls `conn.callExtension(...)` to unregister | `agent_unregistered` |
| `swarm.agent.spawned` (emitEvent broadcast) | Replaced by `spawn()` above — no separate event needed | `agent_registered` |
| `swarm.agent.completed` (emitEvent broadcast) | Replaced by agent `done()` above | `agent_state_changed` → `stopped` |
| `swarm.task.dispatched` (emitEvent broadcast) | `conn.send({ scope }, { type: "task.dispatched", ... })` — typed payload in regular message | `message_sent` |
| `swarm.task.completed` (emitEvent broadcast) | `conn.send({ scope }, { type: "task.completed", ... })` | `message_sent` |
| `swarm.task.status_completed` (emitEvent broadcast) | `conn.send({ scope }, { type: "task.completed", ... })` with richer payload | `message_sent` |
| `swarm.turn.completed` (emitEvent broadcast) | `conn.idle()` + `conn.updateMetadata({ lastStopReason })` | `agent_state_changed` → `idle` |
| `swarm.subagent.started` (emitEvent broadcast) | `conn.spawn({ role: "subagent", metadata: { agentType, sessionId } })` | `agent_registered` |
| `swarm.subagent.stopped` (emitEvent broadcast) | `spawned.done({ exitReason })` | `agent_state_changed` → `stopped` |
| `swarm.teammate.idle` (emitEvent broadcast) | `agent.updateState("idle")` (via sidecar) | `agent_state_changed` → `idle` |
| `swarm.sessionlog.sync` (broadcast fallback) | `conn.callExtension("trajectory/checkpoint", ...)` — keep existing; fallback sends as regular message payload instead of custom event type | `trajectory.checkpoint` |

---

## Implementation steps

### Step 1: Refactor `sidecar-server.mjs` — replace `register`/`unregister` with `spawn`/`done`

**File:** `src/sidecar-server.mjs`

Replace the `register` command handler:
- **Before:** `conn.send({ scope }, { type: "swarm.agent.registered", ... })` — broadcasts a custom message
- **After:** `conn.spawn({ agentId, name, role, scopes, metadata })` — uses SDK primitive; server auto-emits `agent_registered`
- Store spawned agent references in a `Map<agentId, AgentSpawnResult>` instead of just a `Set<agentId>`

Replace the `unregister` command handler:
- **Before:** `conn.send({ scope }, { type: "swarm.agent.unregistered", ... })` — broadcasts custom message
- **After:** Use `conn.callExtension("agents/unregister", { agentId, reason })` or track spawned agent IDs and send a deregistration request. Since the sidecar is the parent, it can manage child agent lifecycle.
- Actually, the simplest approach: call `conn.send()` with method `"map/agents/unregister"` as a request, or use the lower-level approach of sending a state update. Since the sidecar owns the spawned agents, we'll call `conn.callExtension("map/agents/unregister", { agentId, reason })`.
- Remove from tracked agents map

Replace the `trajectory-checkpoint` fallback:
- **Before:** Falls back to `conn.send({ scope }, { type: "swarm.sessionlog.sync", ... })`
- **After:** Falls back to `conn.send({ scope }, { type: "trajectory.checkpoint.fallback", checkpoint })` — still a regular message but with a standardized payload shape, not a custom event type. Or even simpler: just use `{ type: "trajectory.checkpoint", ... }` as the message payload since this is informational.

Keep `emit` command handler for now (backward compat) but mark as deprecated — it's the generic "send arbitrary payload" path.

Keep `state` and `ping` handlers unchanged.

### Step 2: Refactor `map-events.mjs` — replace builders with SDK-aligned builders

**File:** `src/map-events.mjs`

This is where the core change happens. Replace the custom event builders with functions that produce either:
- **Sidecar commands** (for `spawn`/`done`/state updates) — structured for the sidecar socket protocol
- **Message payloads** (for task lifecycle) — sent via `conn.send()` as regular MAP messages

New functions:

```javascript
// Agent lifecycle — produce sidecar commands
export function buildSpawnCommand(agentName, matchedRole, teamName, hookData) → { action: "spawn", agent: { ... } }
export function buildDoneCommand(agentName, matchedRole, teamName) → { action: "done", agentId, reason }
export function buildSubagentSpawnCommand(hookData, teamName) → { action: "spawn", agent: { role: "subagent", ... } }
export function buildSubagentDoneCommand(hookData, teamName) → { action: "done", agentId, reason }

// State updates — produce sidecar commands
export function buildStateCommand(agentId, state, metadata?) → { action: "state", agentId, state, metadata? }

// Task lifecycle — produce message payloads (sent via "emit" or "send")
export function buildTaskDispatchedPayload(hookData, teamName, matchedRole, agentName) → { type: "task.dispatched", ... }
export function buildTaskCompletedPayload(hookData, teamName, matchedRole, agentName) → { type: "task.completed", ... }
export function buildTaskStatusPayload(hookData, teamName, matchedRole) → { type: "task.completed", ... }
```

Remove `emitEvent()` wrapper for agent lifecycle events — those go directly as sidecar commands.
Keep `emitEvent()` only for task-related message payloads (these are still sent as MAP messages to scope, which is fine).

### Step 3: Refactor `map-hook.mjs` — update action handlers

**File:** `scripts/map-hook.mjs`

`handleAgentSpawning()`:
- **Before:** `sendToSidecar({ action: "register", agent: {...} })` + `emitEvent(buildSpawnEvent)` + `emitEvent(buildTaskDispatchedEvent)`
- **After:** `sendToSidecar(buildSpawnCommand(...))` + `emitEvent(buildTaskDispatchedPayload(...))`
- The spawn command replaces both the register and the spawn event — one operation, server auto-emits the event

`handleAgentCompleted()`:
- **Before:** `sendToSidecar({ action: "unregister", ... })` + `emitEvent(buildCompletedEvent)` + `emitEvent(buildTaskCompletedEvent)`
- **After:** `sendToSidecar(buildDoneCommand(...))` + `emitEvent(buildTaskCompletedPayload(...))`

`handleTurnCompleted()`:
- **Before:** `sendToSidecar({ action: "state", state: "idle" })` + `emitEvent(buildTurnCompletedEvent)`
- **After:** `sendToSidecar(buildStateCommand(sidecarId, "idle", { lastStopReason }))` — just a state+metadata update, server auto-emits `agent_state_changed`

`handleSubagentStart()`:
- **Before:** `emitEvent(buildSubagentStartEvent)`
- **After:** `sendToSidecar(buildSubagentSpawnCommand(...))` — spawn in MAP for observability

`handleSubagentStop()`:
- **Before:** `emitEvent(buildSubagentStopEvent)`
- **After:** `sendToSidecar(buildSubagentDoneCommand(...))`

`handleTeammateIdle()`:
- **Before:** `sendToSidecar({ action: "state" })` + `emitEvent(buildTeammateIdleEvent)`
- **After:** `sendToSidecar(buildStateCommand(agentId, "idle"))` — state change only, server auto-emits

`handleTaskCompleted()`:
- **Before:** `emitEvent(buildTaskStatusCompletedEvent)`
- **After:** `emitEvent(buildTaskStatusPayload(...))`

### Step 4: Refactor `map-connection.mjs` — update `fireAndForget` and trajectory fallback

**File:** `src/map-connection.mjs`

`fireAndForget()`:
- Keep as-is but now it sends typed message payloads (for task events) rather than custom event types

`fireAndForgetTrajectory()`:
- **Before:** Fallback broadcasts `{ type: "swarm.sessionlog.sync", ... }`
- **After:** Fallback sends `{ type: "trajectory.checkpoint", checkpoint: {...} }` as a regular message payload — clients looking for trajectory data can filter on this

### Step 5: Update `sidecar-server.mjs` command handler — add `spawn`/`done` commands

**File:** `src/sidecar-server.mjs`

Add new command cases:

```javascript
case "spawn": {
  if (conn) {
    const result = await conn.spawn({
      agentId: command.agent.agentId,
      name: command.agent.name,
      role: command.agent.role,
      scopes: command.agent.scopes,
      metadata: command.agent.metadata,
    });
    registeredAgents.set(command.agent.agentId, result);
  }
  respond(client, { ok: true });
  break;
}

case "done": {
  if (conn) {
    // Unregister the spawned child agent
    try {
      await conn.callExtension("map/agents/unregister", {
        agentId: command.agentId,
        reason: command.reason || "completed",
      });
    } catch {
      // Agent may already be gone
    }
    registeredAgents.delete(command.agentId);
  }
  respond(client, { ok: true });
  break;
}
```

Change `registeredAgents` from `Set` to `Map` in `scripts/map-sidecar.mjs`.

Keep old `register`/`unregister` commands working (deprecated) for backward compat during rollout.

### Step 6: Update tests

**Files:**
- `src/__tests__/map-events.test.mjs` — Update for new function signatures and return shapes
- `src/__tests__/sidecar-server.test.mjs` — Add tests for `spawn`/`done` commands, update `register`/`unregister` tests

### Step 7: Update `CLAUDE.md` documentation

Update the "MAP hooks" section to reflect:
- No custom `swarm.*` event types
- Agent lifecycle uses `spawn()`/`done()` SDK primitives
- Task lifecycle uses typed message payloads
- Turn lifecycle uses `updateState()` + `updateMetadata()`
- Clients subscribe to standard MAP events only

---

## What stays the same

- **Sidecar architecture** — persistent process with socket IPC, unchanged
- **Hook wiring** — same hooks, same scripts, same conditions in `hooks.json`
- **Trajectory checkpoints** — same `callExtension("trajectory/checkpoint")` with broadcast fallback
- **Inbox system** — unchanged (read/clear/format/write)
- **Role matching** — unchanged (`roles.mjs`)
- **Config system** — unchanged (`config.mjs`)
- **Bootstrap flow** — unchanged (`bootstrap.mjs`)
- **Fire-and-forget recovery** — same sidecar → recovery → direct pattern

## What changes

- **No custom event types** — everything uses MAP SDK primitives or typed message payloads
- **Sidecar registers agents properly** — `conn.spawn()` instead of broadcasting fake events
- **Server emits lifecycle events automatically** — clients see `agent_registered`, `agent_state_changed`, etc.
- **Task events are messages, not events** — sent via `conn.send()` with typed payloads
- **Cleaner client integration** — subscribe to standard MAP events, no `swarm.*` parsing needed

## Risk / rollback

- The refactor is fully backward-compatible at the config level (`.claude-swarm.json` unchanged)
- Old `register`/`unregister` sidecar commands still work during transition
- If `conn.spawn()` fails (e.g., server doesn't support it), we can fall back to the old broadcast approach
