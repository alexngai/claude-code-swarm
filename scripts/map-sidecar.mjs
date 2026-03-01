#!/usr/bin/env node
/**
 * map-sidecar.mjs — MAP sidecar process for claude-code-swarm
 *
 * A persistent Node.js process that:
 * 1. Connects to a MAP server via WebSocket
 * 2. Registers as the swarm's root agent
 * 3. Listens for incoming MAP messages → writes to inbox.jsonl
 * 4. Accepts commands from hooks via UNIX socket → forwards to MAP server
 * 5. Manages team agent registrations (register/unregister on spawn/complete)
 * 6. Self-terminates after inactivity timeout (session mode safety net)
 *
 * Usage: node map-sidecar.mjs --server ws://localhost:8080 --scope swarm:team --system-id system-id
 */

import fs from "fs";
import path from "path";
import net from "net";

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultValue = "") {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}

const MAP_SERVER = getArg("server", "ws://localhost:8080");
const MAP_SCOPE = getArg("scope", "swarm:default");
const SYSTEM_ID = getArg("system-id", "system-claude-swarm");
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const INBOX_PATH = ".generated/map/inbox.jsonl";
const SOCKET_PATH = ".generated/map/sidecar.sock";

// ── State ───────────────────────────────────────────────────────────────────

let connection = null;
let socketServer = null;
let inactivityTimer = null;
let registeredAgents = new Set();

// ── MAP Connection ──────────────────────────────────────────────────────────

async function connectToMAP() {
  try {
    const { AgentConnection } = await import("@multi-agent-protocol/sdk");

    // Derive agent name from scope (swarm:get-shit-done → get-shit-done-sidecar)
    const teamName = MAP_SCOPE.replace("swarm:", "");
    const agentName = `${teamName}-sidecar`;

    connection = await AgentConnection.connect(MAP_SERVER, {
      name: agentName,
      role: "sidecar",
      scopes: [MAP_SCOPE],
      metadata: {
        systemId: SYSTEM_ID,
        type: "claude-code-swarm-sidecar",
      },
      reconnection: {
        enabled: true,
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    });

    // Handle incoming messages → write to inbox
    connection.onMessage((message) => {
      resetInactivityTimer();
      try {
        fs.appendFileSync(INBOX_PATH, JSON.stringify(message) + "\n");
      } catch (err) {
        process.stderr.write(`[sidecar] Failed to write inbox: ${err.message}\n`);
      }
    });

    process.stderr.write(`[sidecar] Connected to MAP server at ${MAP_SERVER}\n`);
    process.stderr.write(`[sidecar] Registered as ${agentName} in scope ${MAP_SCOPE}\n`);
  } catch (err) {
    process.stderr.write(`[sidecar] Failed to connect to MAP server: ${err.message}\n`);
    // Don't exit — the UNIX socket can still accept commands for fire-and-forget
  }
}

// ── UNIX Socket Server ──────────────────────────────────────────────────────

function startSocketServer() {
  // Clean up stale socket
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  socketServer = net.createServer((client) => {
    let buffer = "";

    client.on("data", (data) => {
      resetInactivityTimer();
      buffer += data.toString();

      // Process complete lines (NDJSON)
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const command = JSON.parse(line);
          handleCommand(command, client);
        } catch (err) {
          process.stderr.write(`[sidecar] Invalid command: ${err.message}\n`);
        }
      }
    });

    client.on("error", () => {
      // Client disconnected, ignore
    });
  });

  socketServer.listen(SOCKET_PATH, () => {
    process.stderr.write(`[sidecar] Listening on ${SOCKET_PATH}\n`);
  });

  socketServer.on("error", (err) => {
    process.stderr.write(`[sidecar] Socket server error: ${err.message}\n`);
  });
}

// ── Command Handler ─────────────────────────────────────────────────────────

async function handleCommand(command, client) {
  const { action } = command;

  try {
    switch (action) {
      case "emit": {
        // Send an event message to the team scope
        if (connection) {
          await connection.send(
            { scope: MAP_SCOPE },
            command.event,
            command.meta || { relationship: "broadcast" }
          );
        }
        respond(client, { ok: true });
        break;
      }

      case "send": {
        // Send a message to a specific address
        if (connection) {
          await connection.send(
            command.to,
            command.payload,
            command.meta
          );
        }
        respond(client, { ok: true });
        break;
      }

      case "register": {
        // Register a team agent as a child
        if (connection) {
          const { agentId, name, role, parent, scopes, metadata } = command.agent;
          // Use agents.spawn to register with parent relationship
          await connection.send(
            { system: true },
            undefined, // payload not needed for register
            undefined
          );
          // Actually use the register method directly
          // The SDK's spawn() or register() via the connection
          // For now, emit a registration event so observers see it
          await connection.send(
            { scope: MAP_SCOPE },
            {
              type: "swarm.agent.registered",
              agentId,
              name,
              role,
              parent,
              scopes,
              metadata,
            },
            { relationship: "broadcast" }
          );
          registeredAgents.add(agentId);
        }
        respond(client, { ok: true });
        break;
      }

      case "unregister": {
        // Unregister a team agent
        if (connection) {
          const { agentId, reason } = command;
          await connection.send(
            { scope: MAP_SCOPE },
            {
              type: "swarm.agent.unregistered",
              agentId,
              reason: reason || "task completed",
            },
            { relationship: "broadcast" }
          );
          registeredAgents.delete(agentId);
        }
        respond(client, { ok: true });
        break;
      }

      case "state": {
        // Update the sidecar agent's state
        if (connection) {
          try {
            await connection.updateState(command.state);
          } catch {
            // State update failed, not critical
          }
        }
        respond(client, { ok: true });
        break;
      }

      case "ping": {
        respond(client, { ok: true, pid: process.pid });
        break;
      }

      default:
        respond(client, { ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    process.stderr.write(`[sidecar] Command error (${action}): ${err.message}\n`);
    respond(client, { ok: false, error: err.message });
  }
}

function respond(client, data) {
  try {
    client.write(JSON.stringify(data) + "\n");
  } catch {
    // Client may have disconnected
  }
}

// ── Inactivity Timer ────────────────────────────────────────────────────────

function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    process.stderr.write("[sidecar] Inactivity timeout reached, shutting down\n");
    shutdown();
  }, INACTIVITY_TIMEOUT_MS);
}

// ── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown() {
  process.stderr.write("[sidecar] Shutting down...\n");

  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }

  if (socketServer) {
    socketServer.close();
  }

  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  try {
    fs.unlinkSync(".generated/map/sidecar.pid");
  } catch {
    // ignore
  }

  if (connection) {
    try {
      await connection.disconnect();
    } catch {
      // ignore
    }
  }

  process.exit(0);
}

// ── Signal Handlers ─────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (err) => {
  process.stderr.write(`[sidecar] Uncaught exception: ${err.message}\n`);
  shutdown();
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure directories exist
  fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });

  // Start UNIX socket server first (so hooks can connect even if MAP is down)
  startSocketServer();

  // Connect to MAP server
  await connectToMAP();

  // Start inactivity timer
  resetInactivityTimer();

  process.stderr.write("[sidecar] Ready\n");
}

main().catch((err) => {
  process.stderr.write(`[sidecar] Fatal: ${err.message}\n`);
  process.exit(1);
});
