/**
 * sidecar-server.mjs — UNIX socket server and command handler for the MAP sidecar
 *
 * Provides the socket server that hooks communicate with, and the command
 * dispatch logic for all sidecar operations.
 *
 * Supports two transport modes:
 * - "mesh": Uses inbox registry for agent lifecycle (spawn/done), MeshPeer
 *   connection for task bridge events and trajectory.
 * - "websocket": Uses MAP SDK primitives directly (legacy mode).
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
          // Must await the async handler to catch SDK errors;
          // without this, rejections become uncaught and crash the process.
          onCommand(command, client).catch((err) => {
            process.stderr.write(
              `[sidecar] Async command error (${command.action}): ${err.message}\n`
            );
          });
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
 * In mesh mode, agent lifecycle (spawn/done) is delegated to the inbox
 * registry when available, providing structured agent management. Task
 * bridge events and other MAP primitives still go through the connection.
 *
 * In websocket mode, all operations use MAP SDK primitives directly
 * (conn.spawn, conn.updateState, conn.send, etc.).
 *
 * @param {object|null} connection - MAP AgentConnection or MeshPeer connection
 * @param {string} scope - MAP scope name
 * @param {Map} registeredAgents - Map of agentId → spawn metadata
 * @param {object} [opts] - Additional options
 * @param {object} [opts.inboxInstance] - Agent-inbox instance (mesh mode)
 * @param {object} [opts.meshPeer] - MeshPeer instance (mesh mode, for agent registration)
 * @param {string} [opts.transportMode] - "mesh" or "websocket"
 * @returns {Function} async (command, client) => void
 */
export function createCommandHandler(connection, scope, registeredAgents, opts = {}) {
  // Use a getter pattern so the connection ref can be updated
  let conn = connection;
  const { inboxInstance, meshPeer, transportMode = "websocket" } = opts;
  const useMeshRegistry = transportMode === "mesh" && inboxInstance;

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

        // --- Agent lifecycle ---
        // In mesh mode: delegate to inbox registry
        // In websocket mode: use MAP SDK primitives

        case "spawn": {
          const { agentId, name, role, scopes: agentScopes, metadata } =
            command.agent;

          if (useMeshRegistry) {
            // Mesh mode: register via inbox registry + MeshPeer MapServer
            try {
              // Register in inbox storage for message routing
              if (inboxInstance.storage) {
                inboxInstance.storage.putAgent({
                  agent_id: agentId,
                  scope,
                  status: "active",
                  metadata: { name, role, ...metadata },
                  registered_at: new Date().toISOString(),
                  last_active_at: new Date().toISOString(),
                });
              }
              registeredAgents.set(agentId, { name, role, metadata });

              // Also register on the MeshPeer's MapServer for observability
              if (meshPeer) {
                try {
                  await meshPeer.createAgent({ agentId, name, role, metadata });
                } catch {
                  // Best-effort — agent may already exist
                }
              }

              respond(client, { ok: true, agent: { agentId, name, role } });
            } catch (err) {
              process.stderr.write(
                `[sidecar] spawn (mesh) failed: ${err.message}\n`
              );
              respond(client, { ok: false, error: err.message });
            }
          } else if (conn) {
            // WebSocket mode: use MAP SDK
            try {
              const result = await conn.spawn({
                agentId,
                name,
                role,
                scopes: agentScopes,
                metadata,
              });
              registeredAgents.set(agentId, { name, role, metadata });
              respond(client, { ok: true, agent: result });
            } catch (err) {
              process.stderr.write(
                `[sidecar] spawn failed: ${err.message}\n`
              );
              respond(client, { ok: false, error: err.message });
            }
          } else {
            respond(client, { ok: false, error: "no connection" });
          }
          break;
        }

        case "done": {
          const { agentId, reason } = command;

          if (useMeshRegistry) {
            // Mesh mode: disconnect via inbox registry + MeshPeer MapServer
            try {
              // Remove from inbox storage
              if (inboxInstance.storage) {
                try {
                  inboxInstance.storage.putAgent({
                    agent_id: agentId,
                    scope,
                    status: "disconnected",
                    metadata: {},
                    registered_at: new Date().toISOString(),
                    last_active_at: new Date().toISOString(),
                  });
                } catch { /* best-effort */ }
              }
            } catch {
              // Agent may already be gone
            }

            // Also unregister from MeshPeer's MapServer
            if (meshPeer) {
              try {
                meshPeer.server.unregisterAgent(agentId);
              } catch {
                // Best-effort
              }
            }

            registeredAgents.delete(agentId);
          } else if (conn) {
            // WebSocket mode: use MAP SDK
            try {
              await conn.callExtension("map/agents/unregister", {
                agentId,
                reason: reason || "completed",
              });
            } catch {
              // Agent may already be gone
            }
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
                  type: "trajectory.checkpoint",
                  checkpoint: {
                    id: command.checkpoint.id,
                    agentId: command.checkpoint.agentId,
                    sessionId: command.checkpoint.sessionId,
                    label: command.checkpoint.label,
                    metadata: command.checkpoint.metadata,
                  },
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

        // --- Task event bridge (opentasks → MAP) ---
        // These emit task events over the shared connection using
        // the opentasks event bridge pattern. Works identically in
        // both mesh and websocket modes.

        case "bridge-task-created": {
          if (conn) {
            try {
              await conn.send({ scope }, {
                type: "task.created",
                task: command.task,
                _origin: command.agentId || "opentasks",
              }, { relationship: "broadcast" });
            } catch { /* best effort */ }
          }
          respond(client, { ok: true });
          break;
        }

        case "bridge-task-status": {
          if (conn) {
            try {
              await conn.send({ scope }, {
                type: "task.status",
                taskId: command.taskId,
                previous: command.previous || "open",
                current: command.current,
                _origin: command.agentId || "opentasks",
              }, { relationship: "broadcast" });
              // Also emit task.completed for terminal states
              if (command.current === "completed" || command.current === "closed") {
                await conn.send({ scope }, {
                  type: "task.completed",
                  taskId: command.taskId,
                  _origin: command.agentId || "opentasks",
                }, { relationship: "broadcast" });
              }
            } catch { /* best effort */ }
          }
          respond(client, { ok: true });
          break;
        }

        case "bridge-task-assigned": {
          if (conn) {
            try {
              await conn.send({ scope }, {
                type: "task.assigned",
                taskId: command.taskId,
                agentId: command.assignee,
                _origin: command.agentId || "opentasks",
              }, { relationship: "broadcast" });
            } catch { /* best effort */ }
          }
          respond(client, { ok: true });
          break;
        }

        case "state": {
          if (conn) {
            try {
              if (command.agentId) {
                // State update for a specific child agent
                let agentKey = command.agentId;
                let existing = registeredAgents.get(agentKey);
                if (!existing) {
                  // Extract role from fallback ID (e.g. "gsd-coordinator" → "coordinator")
                  const fallbackRole = command.agentId.includes("-")
                    ? command.agentId.split("-").slice(1).join("-")
                    : command.agentId;
                  for (const [id, entry] of registeredAgents) {
                    if (entry.role === fallbackRole || id.endsWith(`/${fallbackRole}`)) {
                      agentKey = id;
                      existing = entry;
                      break;
                    }
                  }
                }
                if (existing) {
                  existing.lastState = command.state;
                  if (command.metadata) {
                    existing.metadata = { ...existing.metadata, ...command.metadata };
                  }
                }
              } else {
                // State update for the sidecar agent itself
                await conn.updateState(command.state);
                if (command.metadata) {
                  await conn.updateMetadata(command.metadata);
                }
              }
            } catch {
              // State update failed, not critical
            }
          }
          respond(client, { ok: true });
          break;
        }

        case "ping": {
          respond(client, { ok: true, pid: process.pid, transport: transportMode });
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
