/**
 * map-events.mjs — Sidecar command builders and message payload builders
 *
 * Produces two kinds of objects:
 * 1. Sidecar commands — { action: "spawn"|"done"|"state", ... }
 *    These use MAP SDK primitives (conn.spawn, conn.done, conn.updateState).
 *    The server auto-emits agent_registered, agent_state_changed, etc.
 *
 * 2. Message payloads — { type: "task.dispatched"|"task.completed", ... }
 *    These are sent via conn.send() as regular MAP messages.
 *    Observers see standard message_sent events.
 *
 * No custom swarm.* event types.
 */

import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForget } from "./map-connection.mjs";

// ── Sidecar command emission ──────────────────────────────────────────────────

/**
 * Send a sidecar command: try sidecar, fall back to fire-and-forget.
 * For "spawn" and "done" commands, the fire-and-forget path can't use SDK
 * primitives (ephemeral connection), so they are silently dropped.
 */
export async function sendCommand(config, command) {
  const sent = await sendToSidecar(command);
  if (!sent) {
    const recovered = await ensureSidecar(config);
    if (recovered) {
      await sendToSidecar(command);
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
export async function emitPayload(config, payload, meta) {
  await sendCommand(config, { action: "emit", event: payload, meta });
}

// ── Agent lifecycle commands (SDK primitives via sidecar) ─────────────────────

/**
 * Build a "spawn" sidecar command for a team agent.
 * Sidecar calls conn.spawn() → server auto-emits agent_registered.
 */
export function buildSpawnCommand(agentName, matchedRole, teamName, hookData) {
  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  return {
    action: "spawn",
    agent: {
      agentId: matchedRole ? `${teamName}-${matchedRole}` : agentName,
      name: matchedRole || agentName,
      role: matchedRole || "internal",
      scopes: [`swarm:${teamName}`],
      metadata: {
        template: teamName,
        isTeamRole: !!matchedRole,
        task: prompt.substring(0, 300),
      },
    },
  };
}

/**
 * Build a "done" sidecar command for a team agent.
 * Sidecar unregisters the agent → server auto-emits agent_unregistered.
 */
export function buildDoneCommand(agentName, matchedRole, teamName) {
  return {
    action: "done",
    agentId: matchedRole ? `${teamName}-${matchedRole}` : agentName,
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
  return {
    type: "task.dispatched",
    taskId: hookData.tool_use_id || "",
    from: `${teamName}-sidecar`,
    targetAgent: matchedRole ? `${teamName}-${matchedRole}` : agentName,
    targetRole: matchedRole || "internal",
    description: prompt.substring(0, 300),
  };
}

/**
 * Build a task.completed message payload.
 */
export function buildTaskCompletedPayload(hookData, teamName, matchedRole, agentName) {
  return {
    type: "task.completed",
    taskId: hookData.tool_use_id || "",
    agent: matchedRole ? `${teamName}-${matchedRole}` : agentName,
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
