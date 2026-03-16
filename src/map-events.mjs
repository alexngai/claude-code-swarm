/**
 * map-events.mjs — Sidecar command builders and message payload builders
 *
 * Produces three kinds of objects:
 * 1. Sidecar commands — { action: "spawn"|"done"|"state", ... }
 *    These use MAP SDK primitives (conn.spawn, conn.done, conn.updateState).
 *    The server auto-emits agent_registered, agent_state_changed, etc.
 *
 * 2. Bridge commands — { action: "bridge-task-created"|"bridge-task-status"|..., ... }
 *    These emit task events via the opentasks MAP event bridge pattern.
 *    The sidecar sends typed messages over the shared MAP connection.
 *    Task data lives in the opentasks daemon; these are observability events.
 *
 * 3. Message payloads — { type: "task.sync"|"task.linked"|..., ... }
 *    These are sent via conn.send() for opentasks bridge events that don't
 *    map to task lifecycle.
 *
 * No custom swarm.* event types.
 */

import { sendToSidecar, ensureSidecar } from "./sidecar-client.mjs";
import { fireAndForget } from "./map-connection.mjs";
import { meshFireAndForget } from "./mesh-connection.mjs";
import { sessionPaths } from "./paths.mjs";

// ── Sidecar command emission ──────────────────────────────────────────────────

/**
 * Send a sidecar command: try sidecar, fall back to fire-and-forget.
 * For "emit" commands, falls back to fire-and-forget direct connection.
 * For SDK-primitive and bridge commands (spawn, done, state, bridge-*),
 * the sidecar is required — silently dropped if unavailable.
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
      // Prefer mesh transport when enabled, fall back to direct WebSocket
      if (config.mesh?.enabled) {
        await meshFireAndForget(config, command.event);
      } else {
        await fireAndForget(config, command.event);
      }
    }
    // spawn/done/state/task-* commands require the sidecar — silently drop if unavailable
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

// ── Task lifecycle (opentasks daemon + MAP event bridge) ───────────────────────
//
// Two-step pattern:
// 1. Create/update the task in opentasks daemon via IPC (graph.create/graph.update)
// 2. Emit the event via sidecar bridge command (bridge-task-created/bridge-task-status)
//
// This decouples task storage (opentasks) from observability (MAP).

/**
 * Create a task in opentasks and emit bridge event.
 * Called from hook handlers after agent spawning.
 *
 * @param {object} config - Plugin config
 * @param {object} hookData - Hook stdin data
 * @param {string} teamName - Team name
 * @param {string} matchedRole - Matched role name
 * @param {string} agentName - Agent name
 * @param {string|null} sessionId - Session ID for per-session routing
 */
export async function handleTaskCreated(config, hookData, teamName, matchedRole, agentName, sessionId) {
  const { createTask, findSocketPath } = await import("./opentasks-client.mjs");

  const prompt =
    hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  const assignee = matchedRole ? `${teamName}-${matchedRole}` : agentName;

  // 1. Create task in opentasks daemon
  const otSocketPath = findSocketPath();
  const node = await createTask(otSocketPath, {
    title: prompt.substring(0, 300),
    status: "open",
    content: prompt,
    assignee,
    metadata: {
      source: "claude-code-swarm",
      teamName,
      role: matchedRole || "internal",
      toolUseId: hookData.tool_use_id || undefined,
    },
  });

  const taskId = node?.id || hookData.tool_use_id || "";

  // 2. Emit bridge event via sidecar (MAP observability)
  await sendCommand(config, {
    action: "bridge-task-created",
    task: {
      id: taskId,
      title: prompt.substring(0, 300),
      status: "open",
      assignee,
    },
    agentId: assignee,
  }, sessionId);

  // 3. Emit assignment event
  if (assignee) {
    await sendCommand(config, {
      action: "bridge-task-assigned",
      taskId,
      assignee,
      agentId: assignee,
    }, sessionId);
  }
}

/**
 * Mark a task completed in opentasks and emit bridge event.
 * Called from hook handlers after agent completion.
 */
export async function handleTaskCompleted(config, hookData, teamName, matchedRole, agentName, sessionId) {
  const { updateTask, findSocketPath } = await import("./opentasks-client.mjs");

  const assignee = matchedRole ? `${teamName}-${matchedRole}` : agentName;
  const taskId = hookData.tool_use_id || hookData.task_id || "";

  // 1. Update task in opentasks daemon
  if (taskId) {
    const otSocketPath = findSocketPath();
    await updateTask(otSocketPath, taskId, {
      status: "closed",
      metadata: {
        completedBy: assignee,
        source: "claude-code-swarm",
      },
    });
  }

  // 2. Emit bridge event via sidecar (MAP observability)
  await sendCommand(config, {
    action: "bridge-task-status",
    taskId,
    previous: "open",
    current: "completed",
    agentId: assignee,
  }, sessionId);
}

/**
 * Handle TaskCompleted hook — richer metadata from Claude's task system.
 */
export async function handleTaskStatusCompleted(config, hookData, teamName, matchedRole, sessionId) {
  const { updateTask, findSocketPath } = await import("./opentasks-client.mjs");

  const agentId = hookData.teammate_name || "";
  const taskId = hookData.task_id || "";

  // 1. Update task in opentasks daemon
  if (taskId) {
    const otSocketPath = findSocketPath();
    await updateTask(otSocketPath, taskId, {
      status: "closed",
      title: hookData.task_subject || undefined,
      metadata: {
        completedBy: agentId,
        teamName: hookData.team_name || teamName,
        role: matchedRole || "unknown",
        isTeamRole: !!matchedRole,
        source: "claude-code-swarm",
      },
    });
  }

  // 2. Emit bridge event via sidecar (MAP observability)
  await sendCommand(config, {
    action: "bridge-task-status",
    taskId,
    previous: "in_progress",
    current: "completed",
    agentId,
  }, sessionId);
}

// ── Task sync payloads (opentasks ↔ MAP bridge) ─────────────────────────────

/**
 * Map Claude task status to canonical status for sync payloads.
 */
function mapClaudeStatus(status) {
  const map = { pending: "open", in_progress: "in_progress", completed: "completed" };
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
 * Parse tool_output from PostToolUse hook data.
 * MCP tools return JSON-stringified results in content[0].text or as a raw string.
 * Returns parsed object or null.
 */
function parseToolOutput(hookData) {
  const raw = hookData.tool_output;
  if (!raw) return null;
  try {
    // tool_output may be a string or already parsed
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    // MCP tools wrap output in { content: [{ text: "..." }] }
    if (data?.content?.[0]?.text) {
      return JSON.parse(data.content[0].text);
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Build bridge commands from opentasks MCP tool use.
 * Translates opentasks MCP tool input/output into sidecar bridge commands.
 * Uses tool_output for created/updated task data (IDs, status, etc.).
 *
 * @param {object} hookData - PostToolUse hook data with tool_name, tool_input, tool_output
 * @returns {object[]}} Array of bridge commands to send via sendCommand
 */
export function buildOpentasksBridgeCommands(hookData) {
  const input = hookData.tool_input || {};
  const output = parseToolOutput(hookData);
  const toolName = hookData.tool_name || "";
  const commands = [];

  // create_task → bridge-task-created + bridge-task-assigned
  if (toolName.includes("create_task")) {
    const taskId = output?.id || "";
    const title = output?.title || input.title || "";
    const status = output?.status || input.status || "open";
    const assignee = output?.assignee || input.assignee || "";
    if (!taskId && !title) return commands;

    commands.push({
      action: "bridge-task-created",
      task: { id: taskId, title, status, assignee },
      agentId: assignee || "opentasks",
    });

    if (assignee) {
      commands.push({
        action: "bridge-task-assigned",
        taskId,
        assignee,
        agentId: assignee,
      });
    }
    return commands;
  }

  // update_task → bridge-task-status
  if (toolName.includes("update_task")) {
    const taskId = output?.id || input.id || "";
    if (!taskId) return commands;

    const previousStatus = input.status ? undefined : "open"; // unknown if explicit status set
    const currentStatus = output?.status || input.status || input.transition || "";
    if (currentStatus) {
      commands.push({
        action: "bridge-task-status",
        taskId,
        previous: previousStatus,
        current: currentStatus,
        agentId: output?.assignee || input.assignee || "opentasks",
      });
    }
    return commands;
  }

  // link → task.linked payload (emitted as message, not bridge command)
  if (toolName.includes("link")) {
    if (!input.fromId || !input.toId) return commands;
    commands.push({
      action: "emit",
      event: {
        type: "task.linked",
        from: input.fromId,
        to: input.toId,
        linkType: input.type || "related",
        remove: input.remove || false,
        source: "opentasks",
      },
    });
    return commands;
  }

  // annotate → task.sync payload (emitted as message)
  if (toolName.includes("annotate")) {
    const target = input.target || output?.target || "";
    if (!target) return commands;
    commands.push({
      action: "emit",
      event: {
        type: "task.sync",
        uri: target,
        annotation: input.feedback?.type || input.type || "comment",
        source: "opentasks",
      },
    });
    return commands;
  }

  // get_task, list_tasks, query, list_providers → read-only, no sync needed
  return commands;
}

// ── Native task hook handlers ─────────────────────────────────────────────────
//
// Extracted from map-hook.mjs so they can be tested directly with real sidecar
// sockets. These handle PostToolUse hooks for Claude's native TaskCreate/TaskUpdate.

/**
 * Map Claude native task status to canonical status.
 */
export function mapNativeTaskStatus(status) {
  const map = { pending: "open", in_progress: "in_progress", completed: "completed" };
  return map[status] || status || "open";
}

/**
 * Handle native TaskCreate hook data → emit bridge events via sidecar.
 * Extracted from map-hook.mjs handleNativeTaskCreated() for testability.
 *
 * @param {object} config - Plugin config (needs config.map.enabled)
 * @param {object} hookData - Hook stdin data with tool_input, tool_output
 * @param {string|null} sessionId - Session ID for per-session routing
 */
export async function handleNativeTaskCreatedEvent(config, hookData, sessionId) {
  const taskId = hookData.tool_output?.id || hookData.tool_input?.id || "";
  const subject = hookData.tool_input?.subject || hookData.tool_output?.subject || "";
  const status = mapNativeTaskStatus(hookData.tool_output?.status || hookData.tool_input?.status || "pending");
  const owner = hookData.tool_input?.owner || hookData.tool_output?.owner || "";

  await sendCommand(config, {
    action: "bridge-task-created",
    task: { id: taskId, title: subject, status, assignee: owner },
    agentId: owner || hookData.session_id || "native",
  }, sessionId);

  if (owner) {
    await sendCommand(config, {
      action: "bridge-task-assigned",
      taskId,
      assignee: owner,
      agentId: owner,
    }, sessionId);
  }
}

/**
 * Handle native TaskUpdate hook data → emit bridge events via sidecar.
 * Extracted from map-hook.mjs handleNativeTaskUpdated() for testability.
 *
 * @param {object} config - Plugin config (needs config.map.enabled)
 * @param {object} hookData - Hook stdin data with tool_input, tool_output
 * @param {string|null} sessionId - Session ID for per-session routing
 */
export async function handleNativeTaskUpdatedEvent(config, hookData, sessionId) {
  const taskId = hookData.tool_input?.taskId || hookData.tool_input?.id || "";
  const newStatus = hookData.tool_input?.status || hookData.tool_output?.status || "";

  if (taskId && newStatus) {
    await sendCommand(config, {
      action: "bridge-task-status",
      taskId,
      current: mapNativeTaskStatus(newStatus),
      agentId: hookData.session_id || "native",
    }, sessionId);
  }
}
