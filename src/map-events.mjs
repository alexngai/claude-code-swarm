/**
 * map-events.mjs — Event builders and emission for claude-code-swarm
 *
 * Constructs structured MAP event payloads and handles the
 * sidecar → recovery → fire-and-forget emission chain.
 */

import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForget } from "./map-connection.mjs";

/**
 * Emit a MAP event: try sidecar, fall back to fire-and-forget.
 */
export async function emitEvent(config, event, meta) {
  const sent = await sendToSidecar({ action: "emit", event, meta });
  if (!sent) {
    const recovered = await ensureSidecar(config);
    if (recovered) {
      await sendToSidecar({ action: "emit", event, meta });
    } else {
      await fireAndForget(config, event);
    }
  }
}

/**
 * Build a swarm.agent.spawned event.
 */
export function buildSpawnEvent(agentName, matchedRole, teamName, hookData) {
  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  return {
    type: "swarm.agent.spawned",
    agent: agentName,
    role: matchedRole || "internal",
    parent: `${teamName}-sidecar`,
    isTeamRole: !!matchedRole,
    task: prompt.substring(0, 300),
  };
}

/**
 * Build a swarm.agent.completed event.
 */
export function buildCompletedEvent(agentName, matchedRole, teamName) {
  return {
    type: "swarm.agent.completed",
    agent: agentName,
    role: matchedRole || "internal",
    parent: `${teamName}-sidecar`,
    isTeamRole: !!matchedRole,
    status: "completed",
  };
}

/**
 * Build a swarm.task.dispatched event.
 */
export function buildTaskDispatchedEvent(
  hookData,
  teamName,
  matchedRole,
  agentName
) {
  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  return {
    type: "swarm.task.dispatched",
    taskId: hookData.tool_use_id || "",
    agent: `${teamName}-sidecar`,
    targetAgent: matchedRole
      ? `${teamName}-${matchedRole}`
      : agentName,
    targetRole: matchedRole || "internal",
    description: prompt.substring(0, 300),
  };
}

/**
 * Build a swarm.task.completed event.
 */
export function buildTaskCompletedEvent(
  hookData,
  teamName,
  matchedRole,
  agentName
) {
  return {
    type: "swarm.task.completed",
    taskId: hookData.tool_use_id || "",
    agent: matchedRole ? `${teamName}-${matchedRole}` : agentName,
    parent: `${teamName}-sidecar`,
    status: "completed",
  };
}

/**
 * Build a swarm.turn.completed event.
 */
export function buildTurnCompletedEvent(teamName, hookData) {
  return {
    type: "swarm.turn.completed",
    agent: `${teamName}-sidecar`,
    stopReason: hookData.stop_reason || "end_turn",
  };
}

/**
 * Build a swarm.subagent.started event.
 */
export function buildSubagentStartEvent(hookData, teamName) {
  return {
    type: "swarm.subagent.started",
    agentId: hookData.agent_id || "",
    agentType: hookData.agent_type || "",
    parent: `${teamName}-sidecar`,
    sessionId: hookData.session_id || "",
  };
}

/**
 * Build a swarm.subagent.stopped event.
 */
export function buildSubagentStopEvent(hookData, teamName) {
  return {
    type: "swarm.subagent.stopped",
    agentId: hookData.agent_id || "",
    agentType: hookData.agent_type || "",
    parent: `${teamName}-sidecar`,
    sessionId: hookData.session_id || "",
    lastMessage: (hookData.last_assistant_message || "").substring(0, 500),
  };
}

/**
 * Build a swarm.teammate.idle event.
 */
export function buildTeammateIdleEvent(hookData, teamName, matchedRole) {
  return {
    type: "swarm.teammate.idle",
    teammateName: hookData.teammate_name || "",
    teamName: hookData.team_name || teamName,
    role: matchedRole || "unknown",
    isTeamRole: !!matchedRole,
  };
}

/**
 * Build a swarm.task.status_completed event.
 */
export function buildTaskStatusCompletedEvent(hookData, teamName, matchedRole) {
  return {
    type: "swarm.task.status_completed",
    taskId: hookData.task_id || "",
    taskSubject: hookData.task_subject || "",
    taskDescription: (hookData.task_description || "").substring(0, 300),
    teammateName: hookData.teammate_name || "",
    teamName: hookData.team_name || teamName,
    role: matchedRole || "unknown",
    isTeamRole: !!matchedRole,
  };
}
