#!/usr/bin/env node
/**
 * map-hook.mjs — Hook helper for claude-code-swarm MAP integration
 *
 * Called by Claude Code hooks with an action argument. Reads hook event data
 * from stdin. Communicates with the MAP sidecar via UNIX socket, with
 * fire-and-forget fallback if sidecar is unavailable.
 *
 * Actions:
 *   inject          — Read inbox.jsonl, format as markdown, output to stdout
 *   agent-spawning  — Emit swarm.agent.spawned + register team agent if applicable
 *   agent-completed — Emit swarm.agent.completed + unregister team agent
 *   turn-completed  — Emit swarm.turn.completed + update agent state
 *
 * Usage: node map-hook.mjs <action>
 *        Hook event data is read from stdin (JSON).
 */

import fs from "fs";
import path from "path";
import net from "net";
import { spawn } from "child_process";

const action = process.argv[2];
const SOCKET_PATH = ".generated/map/sidecar.sock";
const INBOX_PATH = ".generated/map/inbox.jsonl";
const PID_PATH = ".generated/map/sidecar.pid";
const ROLES_PATH = ".generated/map/roles.json";
const CONFIG_PATH = ".claude-swarm.json";

// ── Helpers ─────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function readRoles() {
  try {
    return JSON.parse(fs.readFileSync(ROLES_PATH, "utf-8"));
  } catch {
    return { team: "", roles: [], root: "", companions: [] };
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    // If stdin is already closed or empty
    if (process.stdin.readableEnded) {
      resolve({});
    }
    // Timeout after 1s — hooks shouldn't block
    setTimeout(() => resolve({}), 1000);
  });
}

/**
 * Match a spawned agent name against topology roles.
 * Returns the role name if matched, null otherwise.
 */
function matchRole(agentName, roles) {
  if (!agentName || !roles.roles?.length) return null;
  return roles.roles.find(
    (r) =>
      agentName === r ||
      agentName === `${roles.team}-${r}` ||
      agentName.endsWith(`-${r}`)
  ) || null;
}

// ── Sidecar Communication ───────────────────────────────────────────────────

/**
 * Send a command to the sidecar via UNIX socket.
 * Returns true if successful, false otherwise.
 */
function sendToSidecar(command) {
  return new Promise((resolve) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(command) + "\n");
      // Don't wait for response — fire and forget from hook's perspective
      client.end();
      resolve(true);
    });
    client.on("error", () => resolve(false));
    // Timeout — never block the hook
    setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
  });
}

/**
 * Check if the sidecar is running and attempt recovery if not.
 * Returns true if sidecar is available after this call.
 */
async function ensureSidecar(config) {
  // 1. Try connecting to socket
  const alive = await sendToSidecar({ action: "ping" });
  if (alive) return true;

  // 2. Only attempt recovery in session mode
  if (config.map?.sidecar === "persistent") return false;

  // 3. Check PID
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim());
  } catch {
    // no pid file
  }

  if (pid) {
    try {
      process.kill(pid, 0); // Check if process exists
      // Process exists but socket not ready — wait briefly
      await new Promise((r) => setTimeout(r, 500));
      return sendToSidecar({ action: "ping" });
    } catch {
      // Process is dead — clean up
    }
  }

  // 4. Restart sidecar
  const pluginDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const sidecarPath = path.join(pluginDir, "map-sidecar.mjs");

  const server = config.map?.server || "ws://localhost:8080";
  const scope =
    config.map?.scope || (config.template ? `swarm:${config.template}` : "swarm:default");
  const systemId = config.map?.systemId || "system-claude-swarm";

  try {
    fs.mkdirSync(".generated/map", { recursive: true });

    const child = spawn(
      "node",
      [sidecarPath, "--server", server, "--scope", scope, "--system-id", systemId],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      }
    );
    child.unref();
    fs.writeFileSync(PID_PATH, String(child.pid));

    // Wait for socket to appear (up to 2s)
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (fs.existsSync(SOCKET_PATH)) {
        const ok = await sendToSidecar({ action: "ping" });
        if (ok) return true;
      }
    }
  } catch (err) {
    process.stderr.write(`[map-hook] Recovery failed: ${err.message}\n`);
  }

  return false;
}

/**
 * Fire-and-forget: send event directly to MAP server (no sidecar).
 */
async function fireAndForget(config, event) {
  try {
    const { AgentConnection } = await import("@multi-agent-protocol/sdk");
    const server = config.map?.server || "ws://localhost:8080";
    const scope =
      config.map?.scope || (config.template ? `swarm:${config.template}` : "swarm:default");
    const teamName = scope.replace("swarm:", "");

    const agent = await AgentConnection.connect(server, {
      name: `${teamName}-hook`,
      role: "hook",
      scopes: [scope],
    });

    await agent.send({ scope }, event);
    await agent.disconnect();
  } catch {
    // Silently drop — never block the agent
  }
}

/**
 * Emit an event: try sidecar, fall back to fire-and-forget.
 */
async function emitEvent(config, event, meta) {
  const sent = await sendToSidecar({ action: "emit", event, meta });
  if (!sent) {
    // Try recovery first
    const recovered = await ensureSidecar(config);
    if (recovered) {
      await sendToSidecar({ action: "emit", event, meta });
    } else {
      await fireAndForget(config, event);
    }
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function handleInject() {
  // Read inbox.jsonl, format as markdown, output to stdout
  if (!fs.existsSync(INBOX_PATH)) return;

  let content;
  try {
    content = fs.readFileSync(INBOX_PATH, "utf-8").trim();
  } catch {
    return;
  }

  if (!content) return;

  const lines = content.split("\n").filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (messages.length === 0) return;

  // Clear inbox
  fs.writeFileSync(INBOX_PATH, "");

  // Format as structured markdown
  const now = Date.now();
  const output = [`## [MAP] ${messages.length} pending message${messages.length > 1 ? "s" : ""}`, ""];

  for (const msg of messages) {
    const from = msg.from || "unknown";
    const age = msg.timestamp ? formatAge(now - new Date(msg.timestamp).getTime()) : "unknown";
    const priority = msg.meta?.priority;
    const payload = msg.payload || {};

    output.push(`**From ${from}** (${age} ago)`);

    // Format payload as readable text
    if (typeof payload === "string") {
      output.push(`> ${payload}`);
    } else if (payload.type) {
      output.push(`> [${payload.type}] ${payload.description || payload.message || JSON.stringify(payload)}`);
    } else {
      output.push(`> ${JSON.stringify(payload)}`);
    }

    if (priority && priority !== "normal") {
      output.push(`> Priority: ${priority}`);
    }

    output.push("");
  }

  // Output to stdout → injected into agent's context
  process.stdout.write(output.join("\n"));
}

function formatAge(ms) {
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

async function handleAgentSpawning() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();

  const agentName = hookData.tool_input?.name || hookData.tool_input?.description || "";
  const matchedRole = matchRole(agentName, roles);
  const teamName = roles.team || config.template || "unknown";

  // Register team agent in MAP if it matches a topology role
  if (matchedRole) {
    const agentId = `${teamName}-${matchedRole}`;
    await sendToSidecar({
      action: "register",
      agent: {
        agentId,
        name: matchedRole,
        role: matchedRole,
        parent: `${teamName}-sidecar`,
        scopes: [config.map?.scope || `swarm:${teamName}`],
        metadata: { template: teamName, position: "spawned" },
      },
    });
  }

  // Emit spawn event
  const prompt = hookData.tool_input?.prompt || hookData.tool_input?.description || "";
  await emitEvent(config, {
    type: "swarm.agent.spawned",
    agent: agentName,
    role: matchedRole || "internal",
    parent: `${teamName}-sidecar`,
    isTeamRole: !!matchedRole,
    task: prompt.substring(0, 300),
  });

  // Emit task.dispatched
  await emitEvent(config, {
    type: "swarm.task.dispatched",
    taskId: hookData.tool_use_id || "",
    agent: `${teamName}-sidecar`,
    targetAgent: matchedRole ? `${teamName}-${matchedRole}` : agentName,
    targetRole: matchedRole || "internal",
    description: prompt.substring(0, 300),
  });
}

async function handleAgentCompleted() {
  const config = readConfig();
  const hookData = await readStdin();
  const roles = readRoles();

  const agentName = hookData.tool_input?.name || hookData.tool_input?.description || "";
  const matchedRole = matchRole(agentName, roles);
  const teamName = roles.team || config.template || "unknown";

  // Unregister team agent if it was a topology role
  if (matchedRole) {
    await sendToSidecar({
      action: "unregister",
      agentId: `${teamName}-${matchedRole}`,
      reason: "task completed",
    });
  }

  // Emit completion event
  await emitEvent(config, {
    type: "swarm.agent.completed",
    agent: agentName,
    role: matchedRole || "internal",
    parent: `${teamName}-sidecar`,
    isTeamRole: !!matchedRole,
    status: "completed",
  });

  // Emit task.completed
  await emitEvent(config, {
    type: "swarm.task.completed",
    taskId: hookData.tool_use_id || "",
    agent: matchedRole ? `${teamName}-${matchedRole}` : agentName,
    parent: `${teamName}-sidecar`,
    status: "completed",
  });
}

async function handleTurnCompleted() {
  const config = readConfig();
  const hookData = await readStdin();

  const teamName = config.template || "unknown";

  // Update state to idle
  await sendToSidecar({ action: "state", state: "idle" });

  // Emit turn completed event
  await emitEvent(config, {
    type: "swarm.turn.completed",
    agent: `${teamName}-sidecar`,
    stopReason: hookData.stop_reason || "end_turn",
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    switch (action) {
      case "inject":
        await handleInject();
        break;
      case "agent-spawning":
        await handleAgentSpawning();
        break;
      case "agent-completed":
        await handleAgentCompleted();
        break;
      case "turn-completed":
        await handleTurnCompleted();
        break;
      default:
        process.stderr.write(`[map-hook] Unknown action: ${action}\n`);
    }
  } catch (err) {
    // Never exit non-zero — don't block the agent
    process.stderr.write(`[map-hook] Error in ${action}: ${err.message}\n`);
  }
}

main();
