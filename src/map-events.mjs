/**
 * map-events.mjs — Sidecar command builders and message payload builders
 *
 * Produces two kinds of objects:
 * 1. Sidecar commands — { action: "spawn"|"done"|"state", ... }
 *    These use MAP SDK primitives (conn.spawn, conn.done, conn.updateState).
 *    The server auto-emits agent_registered, agent_state_changed, etc.
 *
 * 2. Message payloads — { type: "task.dispatched"|"task.completed"|"task.sync"|..., ... }
 *    These are sent via conn.send() as regular MAP messages.
 *    Observers see standard message_sent events.
 *
 * 3. Task sync payloads — { type: "task.sync"|"task.claimed"|"task.linked", ... }
 *    Used for bridging Claude tasks and opentasks MCP operations to MAP.
 *    Extends the existing task lifecycle payloads with richer sync semantics.
 *
 * No custom swarm.* event types.
 */

import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForget } from "./map-connection.mjs";
import { sessionPaths } from "./paths.mjs";

// ── Sidecar command emission ──────────────────────────────────────────────────

/**
 * Send a sidecar command: try sidecar, fall back to fire-and-forget.
 * For "spawn" and "done" commands, the fire-and-forget path can't use SDK
 * primitives (ephemeral connection), so they are silently dropped.
 * When sessionId is provided, uses per-session sidecar paths.
 */
export async function sendCommand(config, command, sessionId) {
  const sPaths = sessionPaths(sessionId);
  const sent = await sendToSidecar(command, sPaths.socketPath);
  if (!sent) {
    const recovered = await ensureSidecar(config, sessionId);
    if (recovered) {
      await sendToSidecar(command, sPaths.socketPath);
    } else if (command.action === "emit") {
      // Only message payloads can be fire-and-forget sent
      await fireAndForget(config, command.event);
    }
    // spawn/done/state commands require the sidecar — silently drop if unavailable
  }
}

/**
 * Emit a message payload to the MAP scope via the sidecar.
 */
export async function emitPayload(config, payload, meta, sessionId) {
  await sendCommand(config, { action: "emit", event: payload, meta }, sessionId);
}

// ── Agent lifecycle commands (SDK primitives via sidecar) ─────────────────────

/**
 * Build the agent ID in <session-id>/<role> format.
 * Uses tool_use_id as a unique session-like identifier for the spawned agent,
 * combined with the matched role. Falls back to agentName if no role matched.
 *
 * This ensures duplicate roles (e.g. two researchers) get unique IDs:
 *   "tu_abc123/researcher", "tu_def456/researcher"
 *
 * The scope (leader's session) groups all agents in the same team.
 */
export function buildAgentId(agentName, matchedRole, hookData) {
  const sessionPrefix = hookData.tool_use_id || hookData.session_id || Date.now().toString(36);
  const role = matchedRole || agentName;
  return `${sessionPrefix}/${role}`;
}

/**
 * Build a "spawn" sidecar command for a team agent.
 * Sidecar calls conn.spawn() → server auto-emits agent_registered.
 *
 * Agent IDs use <tool_use_id>/<role> format for uniqueness.
 * Scope uses the leader's session ID for team grouping.
 */
export function buildSpawnCommand(agentName, matchedRole, teamName, hookData) {
  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  const agentId = buildAgentId(agentName, matchedRole, hookData);
  return {
    action: "spawn",
    agent: {
      agentId,
      name: matchedRole || agentName,
      role: matchedRole || "internal",
      scopes: [hookData.session_id || `swarm:${teamName}`],
      metadata: {
        template: teamName,
        isTeamRole: !!matchedRole,
        task: prompt.substring(0, 300),
        toolUseId: hookData.tool_use_id || "",
      },
    },
  };
}

/**
 * Build a "done" sidecar command for a team agent.
 * Sidecar unregisters the agent → server auto-emits agent_unregistered.
 */
export function buildDoneCommand(agentName, matchedRole, teamName, hookData) {
  const agentId = buildAgentId(agentName, matchedRole, hookData);
  return {
    action: "done",
    agentId,
    reason: "completed",
  };
}

/**
 * Build a "spawn" sidecar command for a subagent.
 */
export function buildSubagentSpawnCommand(hookData, teamName) {
  return {
    action: "spawn",
    agent: {
      agentId: hookData.agent_id || `${teamName}-subagent-${Date.now()}`,
      name: hookData.agent_type || "subagent",
      role: "subagent",
      scopes: [`swarm:${teamName}`],
      metadata: {
        agentType: hookData.agent_type || "",
        sessionId: hookData.session_id || "",
        isTeamRole: false,
      },
    },
  };
}

/**
 * Build a "done" sidecar command for a subagent.
 */
export function buildSubagentDoneCommand(hookData, teamName) {
  return {
    action: "done",
    agentId: hookData.agent_id || "",
    reason: (hookData.last_assistant_message || "").substring(0, 500) || "completed",
  };
}

// ── State update commands ─────────────────────────────────────────────────────

/**
 * Build a "state" sidecar command.
 * For turn completion: updates the sidecar agent's state to idle + metadata.
 * For teammate idle: updates a specific child agent's state.
 */
export function buildStateCommand(agentId, state, metadata) {
  const cmd = { action: "state", state };
  if (agentId) cmd.agentId = agentId;
  if (metadata) cmd.metadata = metadata;
  return cmd;
}

// ── Task lifecycle payloads (sent as MAP messages) ────────────────────────────

/**
 * Build a task.dispatched message payload.
 * Sent via conn.send() → observers see message_sent event.
 */
export function buildTaskDispatchedPayload(hookData, teamName, matchedRole, agentName) {
  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  const agentId = buildAgentId(agentName, matchedRole, hookData);
  return {
    type: "task.dispatched",
    taskId: hookData.tool_use_id || "",
    from: `${hookData.session_id || teamName}-sidecar`,
    targetAgent: agentId,
    targetRole: matchedRole || "internal",
    description: prompt.substring(0, 300),
  };
}

/**
 * Build a task.completed message payload.
 */
export function buildTaskCompletedPayload(hookData, teamName, matchedRole, agentName) {
  const agentId = buildAgentId(agentName, matchedRole, hookData);
  return {
    type: "task.completed",
    taskId: hookData.tool_use_id || "",
    agent: agentId,
    status: "completed",
  };
}

/**
 * Build a task.completed message payload from TaskCompleted hook data.
 */
export function buildTaskStatusPayload(hookData, teamName, matchedRole) {
  return {
    type: "task.completed",
    taskId: hookData.task_id || "",
    taskSubject: hookData.task_subject || "",
    taskDescription: (hookData.task_description || "").substring(0, 300),
    agent: hookData.teammate_name || "",
    teamName: hookData.team_name || teamName,
    role: matchedRole || "unknown",
    isTeamRole: !!matchedRole,
    status: "completed",
  };
}

// ── Task sync payloads (opentasks ↔ MAP bridge) ─────────────────────────────

/**
 * Map Claude task status to canonical status for sync payloads.
 */
function mapClaudeStatus(status) {
  const map = { pending: "open", in_progress: "in_progress", completed: "closed" };
  return map[status] || status || "open";
}

/**
 * Build a task.sync payload for Claude task changes.
 * Emitted alongside task.dispatched/task.completed for richer sync semantics.
 */
export function buildTaskSyncPayload(hookData, teamName) {
  return {
    type: "task.sync",
    uri: `claude://${teamName}/${hookData.tool_input?.taskId || hookData.task_id || ""}`,
    status: mapClaudeStatus(hookData.tool_input?.status),
    subject: hookData.tool_input?.subject || hookData.task_subject || "",
    source: "claude-code",
  };
}

/**
 * Build a task sync payload from opentasks MCP tool use.
 * Translates opentasks MCP tool input/output into MAP sync events.
 *
 * @param {object} hookData - PostToolUse hook data with tool_name, tool_input, tool_output
 * @returns {object|null} MAP payload or null if not a syncable operation
 */
export function buildOpentasksSyncPayload(hookData) {
  const input = hookData.tool_input || {};
  const toolName = hookData.tool_name || "";

  // link tool → task.linked
  if (toolName.includes("link")) {
    if (!input.from || !input.to) return null;
    return {
      type: "task.linked",
      from: input.from,
      to: input.to,
      linkType: input.type || "related",
      remove: input.remove || false,
      source: "opentasks",
    };
  }

  // annotate tool → task.sync with annotation info
  if (toolName.includes("annotate")) {
    if (!input.target) return null;
    return {
      type: "task.sync",
      uri: input.target,
      annotation: input.feedback?.type || "comment",
      source: "opentasks",
    };
  }

  // query tool → read-only, no sync needed
  if (toolName.includes("query")) {
    return null;
  }

  // Generic fallback for other opentasks operations
  if (input.target || input.id) {
    return {
      type: "task.sync",
      uri: input.target || input.id,
      status: input.status,
      source: "opentasks",
    };
  }

  return null;
}
