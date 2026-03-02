#!/usr/bin/env node
/**
 * map-hook.mjs — Hook helper for claude-code-swarm MAP integration
 *
 * Thin wrapper: reads action + stdin, dispatches to src/ modules.
 *
 * Actions:
 *   inject          — Read inbox, format as markdown, output to stdout
 *   agent-spawning  — Register agent + emit spawn events
 *   agent-completed — Unregister agent + emit completion events
 *   turn-completed  — Update state + emit turn event
 *   sessionlog-sync — Sync sessionlog state to MAP
 *
 * Usage: node map-hook.mjs <action>
 *        Hook event data is read from stdin (JSON).
 */

import { readConfig, resolveTeamName } from "../src/config.mjs";
import { readRoles, matchRole } from "../src/roles.mjs";
import { readInbox, clearInbox, formatInboxAsMarkdown } from "../src/inbox.mjs";
import { sendToSidecar } from "../src/sidecar-client.mjs";
import {
  emitEvent,
  buildSpawnEvent,
  buildCompletedEvent,
  buildTaskDispatchedEvent,
  buildTaskCompletedEvent,
  buildTurnCompletedEvent,
  buildSubagentStartEvent,
  buildSubagentStopEvent,
  buildTeammateIdleEvent,
  buildTaskStatusCompletedEvent,
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

  // Register team agent in MAP if it matches a topology role
  if (matchedRole) {
    await sendToSidecar({
      action: "register",
      agent: {
        agentId: `${teamName}-${matchedRole}`,
        name: matchedRole,
        role: matchedRole,
        parent: `${teamName}-sidecar`,
        scopes: [config.map?.scope || `swarm:${teamName}`],
        metadata: { template: teamName, position: "spawned" },
      },
    });
  }

  // Emit spawn + task.dispatched events
  await emitEvent(config, buildSpawnEvent(agentName, matchedRole, teamName, hookData));
  await emitEvent(config, buildTaskDispatchedEvent(hookData, teamName, matchedRole, agentName));
}

async function handleAgentCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();

  const agentName = hookData.tool_input?.name || hookData.tool_input?.description || "";
  const matchedRole = matchRole(agentName, roles);
  const teamName = resolveTeamName(config);

  // Unregister team agent if it was a topology role
  if (matchedRole) {
    await sendToSidecar({
      action: "unregister",
      agentId: `${teamName}-${matchedRole}`,
      reason: "task completed",
    });
  }

  // Emit completed + task.completed events
  await emitEvent(config, buildCompletedEvent(agentName, matchedRole, teamName));
  await emitEvent(config, buildTaskCompletedEvent(hookData, teamName, matchedRole, agentName));
}

async function handleTurnCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const teamName = resolveTeamName(config);

  await sendToSidecar({ action: "state", state: "idle" });
  await emitEvent(config, buildTurnCompletedEvent(teamName, hookData));
}

async function handleSessionlogSync() {
  const config = readConfig();
  await syncSessionlog(config);
}

async function handleSubagentStart() {
  const config = readConfig();
  const hookData = await readStdin();
  const teamName = resolveTeamName(config);

  await emitEvent(config, buildSubagentStartEvent(hookData, teamName));
}

async function handleSubagentStop() {
  const config = readConfig();
  const hookData = await readStdin();
  const teamName = resolveTeamName(config);

  await emitEvent(config, buildSubagentStopEvent(hookData, teamName));
}

async function handleTeammateIdle() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  // Update sidecar state for this teammate
  if (matchedRole) {
    await sendToSidecar({
      action: "state",
      state: "idle",
      agentId: `${teamName}-${matchedRole}`,
    });
  }

  await emitEvent(config, buildTeammateIdleEvent(hookData, teamName, matchedRole));
}

async function handleTaskCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();
  const teamName = resolveTeamName(config);

  const teammateName = hookData.teammate_name || "";
  const matchedRole = matchRole(teammateName, roles);

  await emitEvent(config, buildTaskStatusCompletedEvent(hookData, teamName, matchedRole));
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
