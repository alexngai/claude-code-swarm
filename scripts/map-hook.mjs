#!/usr/bin/env node
/**
 * map-hook.mjs — Hook helper for claude-code-swarm MAP integration
 *
 * Thin wrapper: reads action + stdin, dispatches to src/ modules.
 * Uses MAP SDK primitives via the sidecar (spawn/done/state) for agent
 * lifecycle. Task events go through opentasks daemon (graph CRUD) +
 * MAP event bridge (observability). No custom swarm.* event types.
 *
 * All handlers extract session_id from hook stdin data and pass it
 * through to sendCommand/emitPayload for per-session sidecar routing.
 *
 * Actions:
 *   inject              — Read inbox, format as markdown, forward task.* to opentasks, output to stdout
 *   turn-completed      — Update sidecar state to idle
 *   sessionlog-sync     — Sync sessionlog state to MAP
 *   subagent-start      — Spawn subagent in MAP
 *   subagent-stop       — Done subagent in MAP
 *   teammate-idle       — Update teammate state to idle
 *   task-completed      — Complete task in opentasks + emit bridge event
 *   opentasks-mcp-used  — Bridge opentasks MCP tool use → MAP task sync payload
 *   sessionlog-dispatch — Dispatch a sessionlog lifecycle hook via programmatic API
 *
 * Usage: node map-hook.mjs <action>
 *        Hook event data is read from stdin (JSON).
 */

import { readConfig, resolveTeamName } from "../src/config.mjs";
import { createLogger, init as initLog } from "../src/log.mjs";
import { configureNodePath } from "../src/swarmkit-resolver.mjs";

// Configure NODE_PATH so dynamic imports of globally-installed packages
// resolve correctly when hooks restart the sidecar or use fire-and-forget.
configureNodePath();

const log = createLogger("map-hook");
import { readRoles, matchRole } from "../src/roles.mjs";
import { formatInboxAsMarkdown } from "../src/inbox.mjs";
import { sendToInbox } from "../src/sidecar-client.mjs";
import { sessionPaths } from "../src/paths.mjs";
import {
  sendCommand,
  emitPayload,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  handleTaskStatusCompleted,
  buildOpentasksBridgeCommands,
  handleNativeTaskCreatedEvent,
  handleNativeTaskUpdatedEvent,
} from "../src/map-events.mjs";
import { syncSessionlog, dispatchSessionlogHook } from "../src/sessionlog.mjs";
import { findSocketPath, pushSyncEvent } from "../src/opentasks-client.mjs";

const action = process.argv[2];

// ── Stdin reader ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    if (process.stdin.readableEnded) resolve({});
    setTimeout(() => resolve({}), 1000);
  });
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleInject(hookData, sessionId) {
  const sPaths = sessionPaths(sessionId);
  const config = readConfig();

  if (!config.inbox?.enabled) return;

  // Only check messages addressed to the main agent (not all scope messages).
  // Per-agent messages stay in storage for agents to pull via MCP tools.
  const teamName = resolveTeamName(config);
  const mainAgentId = `${teamName}-main`;
  const scope = config.map?.scope || "default";

  const resp = await sendToInbox(
    { action: "check_inbox", agentId: mainAgentId, scope, unreadOnly: true, clear: true },
    sPaths.inboxSocketPath
  );
  if (!resp || !resp.ok || !resp.messages?.length) return;

  // Forward task.* events to opentasks graph if enabled
  if (config.opentasks?.enabled) {
    const otSocketPath = findSocketPath();
    const taskEvents = resp.messages.filter(
      (m) => m.content?.type === "event" && m.content?.event?.startsWith("task.")
    );
    for (const evt of taskEvents) {
      pushSyncEvent(otSocketPath, evt.content).catch(() => {});
    }
  }

  const output = formatInboxAsMarkdown(resp.messages);
  if (output) process.stdout.write(output);
}

async function handleTurnCompleted(hookData, sessionId) {
  const config = readConfig();

  // Update sidecar state to idle (server auto-emits agent_state_changed)
  const stopReason = hookData.stop_reason || "end_turn";
  await sendCommand(config, buildStateCommand(null, "idle", { lastStopReason: stopReason }), sessionId);
}

async function handleSessionlogSync(hookData, sessionId) {
  const config = readConfig();
  await syncSessionlog(config, sessionId);
}

async function handleSubagentStart(hookData, sessionId) {
  const config = readConfig();
  const teamName = resolveTeamName(config);

  // Spawn subagent in MAP (server auto-emits agent_registered)
  await sendCommand(config, buildSubagentSpawnCommand(hookData, teamName), sessionId);
}

async function handleSubagentStop(hookData, sessionId) {
  const config = readConfig();
  const teamName = resolveTeamName(config);

  // Mark subagent done (server auto-emits agent_unregistered)
  await sendCommand(config, buildSubagentDoneCommand(hookData, teamName), sessionId);
}

async function handleTeammateIdle(hookData, sessionId) {
  const config = readConfig();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  // Update teammate state to idle (server auto-emits agent_state_changed)
  // Use teammate_name as a best-effort agent ID for state updates
  // (TeammateIdle doesn't have tool_use_id, so we can't reconstruct the full session-based ID)
  const agentId = matchedRole ? `${teamName}-${matchedRole}` : null;
  await sendCommand(config, buildStateCommand(agentId, "idle", { teammateName }), sessionId);
}

async function handleTaskCompletedHook(hookData, sessionId) {
  const config = readConfig();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  // Update task in opentasks + emit bridge event to MAP
  await handleTaskStatusCompleted(config, hookData, teamName, matchedRole, sessionId);
}

async function handleOpentasksMcpUsed(hookData, sessionId) {
  const config = readConfig();
  if (!config.map.enabled) return; // Only bridge when MAP is enabled

  const commands = buildOpentasksBridgeCommands(hookData);
  for (const cmd of commands) {
    await sendCommand(config, cmd, sessionId);
  }
}

async function handleNativeTaskCreated(hookData, sessionId) {
  const config = readConfig();
  if (!config.map?.enabled) return;

  await handleNativeTaskCreatedEvent(config, hookData, sessionId);
}

async function handleNativeTaskUpdated(hookData, sessionId) {
  const config = readConfig();
  if (!config.map?.enabled) return;

  await handleNativeTaskUpdatedEvent(config, hookData, sessionId);
}

async function handleSessionlogDispatch(hookData) {
  const sessionlogHookName = process.argv[3];
  if (!sessionlogHookName) {
    log.warn("sessionlog-dispatch: missing hook name argument");
    return;
  }
  await dispatchSessionlogHook(sessionlogHookName, hookData);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const hookData = await readStdin();
  const sessionId = hookData.session_id || null;
  const config = readConfig();
  initLog({ ...config.log, sessionId });

  try {
    switch (action) {
      case "inject": await handleInject(hookData, sessionId); break;
      case "turn-completed": await handleTurnCompleted(hookData, sessionId); break;
      case "sessionlog-sync": await handleSessionlogSync(hookData, sessionId); break;
      case "subagent-start": await handleSubagentStart(hookData, sessionId); break;
      case "subagent-stop": await handleSubagentStop(hookData, sessionId); break;
      case "teammate-idle": await handleTeammateIdle(hookData, sessionId); break;
      case "task-completed": await handleTaskCompletedHook(hookData, sessionId); break;
      case "opentasks-mcp-used": await handleOpentasksMcpUsed(hookData, sessionId); break;
      case "native-task-created": await handleNativeTaskCreated(hookData, sessionId); break;
      case "native-task-updated": await handleNativeTaskUpdated(hookData, sessionId); break;
      case "sessionlog-dispatch": await handleSessionlogDispatch(hookData); break;
      default:
        log.warn("unknown action", { action });
    }
  } catch (err) {
    log.error("hook action failed", { action, error: err.message });
  }
}

main();
