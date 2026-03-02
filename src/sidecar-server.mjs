/**
 * sidecar-server.mjs — UNIX socket server and command handler for the MAP sidecar
 *
 * Provides the socket server that hooks communicate with, and the command
 * dispatch logic for all sidecar operations.
 */

import fs from "fs";
import net from "net";

/**
 * Create a UNIX socket server that accepts NDJSON commands.
 *
 * @param {string} socketPath - Path to the UNIX socket file
 * @param {Function} onCommand - async (command, client) => void
 * @returns {net.Server}
 */
export function createSocketServer(socketPath, onCommand) {
  // Clean up stale socket
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }

  const server = net.createServer((client) => {
    let buffer = "";

    client.on("data", (data) => {
      buffer += data.toString();

      // Process complete lines (NDJSON)
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const command = JSON.parse(line);
          onCommand(command, client);
        } catch (err) {
          process.stderr.write(
            `[sidecar] Invalid command: ${err.message}\n`
          );
        }
      }
    });

    client.on("error", () => {
      // Client disconnected, ignore
    });
  });

  server.listen(socketPath, () => {
    process.stderr.write(`[sidecar] Listening on ${socketPath}\n`);
  });

  server.on("error", (err) => {
    process.stderr.write(
      `[sidecar] Socket server error: ${err.message}\n`
    );
  });

  return server;
}

/**
 * Create a command handler for the sidecar socket server.
 *
 * @param {object|null} connection - MAP AgentConnection (or null if disconnected)
 * @param {string} scope - MAP scope name
 * @param {Set} registeredAgents - Set of registered agent IDs
 * @returns {Function} async (command, client) => void
 */
export function createCommandHandler(connection, scope, registeredAgents) {
  // Use a getter pattern so the connection ref can be updated
  let conn = connection;

  const handler = async (command, client) => {
    const { action } = command;

    try {
      switch (action) {
        case "emit": {
          if (conn) {
            await conn.send(
              { scope },
              command.event,
              command.meta || { relationship: "broadcast" }
            );
          }
          respond(client, { ok: true });
          break;
        }

        case "send": {
          if (conn) {
            await conn.send(command.to, command.payload, command.meta);
          }
          respond(client, { ok: true });
          break;
        }

        case "register": {
          if (conn) {
            const { agentId, name, role, parent, scopes, metadata } =
              command.agent;
            await conn.send(
              { scope },
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
          if (conn) {
            const { agentId, reason } = command;
            await conn.send(
              { scope },
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

        case "trajectory-checkpoint": {
          if (conn) {
            try {
              await conn.callExtension("trajectory/checkpoint", {
                checkpoint: command.checkpoint,
              });
              respond(client, { ok: true, method: "trajectory" });
            } catch (err) {
              process.stderr.write(
                `[sidecar] trajectory/checkpoint not supported, falling back to broadcast: ${err.message}\n`
              );
              await conn.send(
                { scope },
                {
                  type: "swarm.sessionlog.sync",
                  ...command.checkpoint.metadata,
                  checkpointId: command.checkpoint.id,
                  agentId: command.checkpoint.agentId,
                  sessionId: command.checkpoint.sessionId,
                  label: command.checkpoint.label,
                },
                { relationship: "broadcast" }
              );
              respond(client, { ok: true, method: "broadcast-fallback" });
            }
          } else {
            respond(client, { ok: false, error: "no connection" });
          }
          break;
        }

        case "state": {
          if (conn) {
            try {
              await conn.updateState(command.state);
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
      process.stderr.write(
        `[sidecar] Command error (${action}): ${err.message}\n`
      );
      respond(client, { ok: false, error: err.message });
    }
  };

  // Allow updating the connection reference
  handler.setConnection = (newConn) => {
    conn = newConn;
  };

  return handler;
}

/**
 * Write a JSON response to a socket client.
 */
export function respond(client, data) {
  try {
    client.write(JSON.stringify(data) + "\n");
  } catch {
    // Client may have disconnected
  }
}
