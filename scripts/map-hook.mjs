#!/usr/bin/env node
/**
 * map-hook.mjs — Hook helper for claude-code-swarm MAP integration
 *
 * Thin wrapper: reads action + stdin, dispatches to src/ modules.
 * Uses MAP SDK primitives via the sidecar (spawn/done/state) for agent
 * lifecycle, and typed message payloads for task lifecycle.
 * No custom swarm.* event types.
 *
 * Actions:
 *   inject          — Read inbox, format as markdown, output to stdout
 *   agent-spawning  — Spawn agent in MAP + emit task.dispatched payload
 *   agent-completed — Done agent in MAP + emit task.completed payload
 *   turn-completed  — Update sidecar state to idle
 *   sessionlog-sync — Sync sessionlog state to MAP
 *   subagent-start  — Spawn subagent in MAP
 *   subagent-stop   — Done subagent in MAP
 *   teammate-idle   — Update teammate state to idle
 *   task-completed  — Emit task.completed payload
 *
 * Usage: node map-hook.mjs <action>
 *        Hook event data is read from stdin (JSON).
 */

import { readConfig, resolveTeamName } from "../src/config.mjs";
import { readRoles, matchRole } from "../src/roles.mjs";
import { readInbox, clearInbox, formatInboxAsMarkdown } from "../src/inbox.mjs";
import {
  sendCommand,
  emitPayload,
  buildSpawnCommand,
  buildDoneCommand,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  buildTaskDispatchedPayload,
  buildTaskCompletedPayload,
  buildTaskStatusPayload,
} from "../src/map-events.mjs";
import { syncSessionlog } from "../src/sessionlog.mjs";

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

async function handleInject() {
  const messages = readInbox();
  if (!messages.length) return;
  clearInbox();
  const output = formatInboxAsMarkdown(messages);
  if (output) process.stdout.write(output);
}

async function handleAgentSpawning() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();

  const agentName = hookData.tool_input?.name || hookData.tool_input?.description || "";
  const matchedRole = matchRole(agentName, roles);
  const teamName = resolveTeamName(config);

  // Spawn agent in MAP via sidecar (server auto-emits agent_registered)
  if (matchedRole) {
    await sendCommand(config, buildSpawnCommand(agentName, matchedRole, teamName, hookData));
  }

  // Emit task.dispatched as a regular MAP message
  await emitPayload(config, buildTaskDispatchedPayload(hookData, teamName, matchedRole, agentName));
}

async function handleAgentCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();

  const agentName = hookData.tool_input?.name || hookData.tool_input?.description || "";
  const matchedRole = matchRole(agentName, roles);
  const teamName = resolveTeamName(config);

  // Mark agent done in MAP via sidecar (server auto-emits agent_unregistered)
  if (matchedRole) {
    await sendCommand(config, buildDoneCommand(agentName, matchedRole, teamName));
  }

  // Emit task.completed as a regular MAP message
  await emitPayload(config, buildTaskCompletedPayload(hookData, teamName, matchedRole, agentName));
}

async function handleTurnCompleted() {
  const config = readConfig();
  const hookData = await readStdin();

  // Update sidecar state to idle (server auto-emits agent_state_changed)
  const stopReason = hookData.stop_reason || "end_turn";
  await sendCommand(config, buildStateCommand(null, "idle", { lastStopReason: stopReason }));
}

async function handleSessionlogSync() {
  const config = readConfig();
  await syncSessionlog(config);
}

async function handleSubagentStart() {
  const config = readConfig();
  const hookData = await readStdin();
  const teamName = resolveTeamName(config);

  // Spawn subagent in MAP (server auto-emits agent_registered)
  await sendCommand(config, buildSubagentSpawnCommand(hookData, teamName));
}

async function handleSubagentStop() {
  const config = readConfig();
  const hookData = await readStdin();
  const teamName = resolveTeamName(config);

  // Mark subagent done (server auto-emits agent_unregistered)
  await sendCommand(config, buildSubagentDoneCommand(hookData, teamName));
}

async function handleTeammateIdle() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  // Update teammate state to idle (server auto-emits agent_state_changed)
  const agentId = matchedRole ? `${teamName}-${matchedRole}` : null;
  await sendCommand(config, buildStateCommand(agentId, "idle"));
}

async function handleTaskCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  // Emit task.completed as a regular MAP message
  await emitPayload(config, buildTaskStatusPayload(hookData, teamName, matchedRole));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    switch (action) {
      case "inject": await handleInject(); break;
      case "agent-spawning": await handleAgentSpawning(); break;
      case "agent-completed": await handleAgentCompleted(); break;
      case "turn-completed": await handleTurnCompleted(); break;
      case "sessionlog-sync": await handleSessionlogSync(); break;
      case "subagent-start": await handleSubagentStart(); break;
      case "subagent-stop": await handleSubagentStop(); break;
      case "teammate-idle": await handleTeammateIdle(); break;
      case "task-completed": await handleTaskCompleted(); break;
      default:
        process.stderr.write(`[map-hook] Unknown action: ${action}\n`);
    }
  } catch (err) {
    process.stderr.write(`[map-hook] Error in ${action}: ${err.message}\n`);
  }
}

main();
