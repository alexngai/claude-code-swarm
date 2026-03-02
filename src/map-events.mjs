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
