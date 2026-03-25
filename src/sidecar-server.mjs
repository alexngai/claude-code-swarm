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
import { createLogger } from "./log.mjs";

const log = createLogger("sidecar");

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
            log.error("async command error", { action: command.action, error: err.message });
          });
        } catch (err) {
          log.warn("invalid command", { error: err.message });
        }
      }
    });

    client.on("error", () => {
      // Client disconnected, ignore
    });
  });

  server.listen(socketPath, () => {
    log.info("listening", { socketPath });
  });

  server.on("error", (err) => {
    log.error("socket server error", { error: err.message });
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
  let _trajectoryResourceId = null; // Cached resource_id from server response
  const { inboxInstance, meshPeer, transportMode = "websocket" } = opts;
  const useMeshRegistry = transportMode === "mesh" && inboxInstance;

  // Connection-ready gate: commands that need `conn` await this promise.
  // If connection is already available, resolves immediately.
  // When connection arrives later (via setConnection), resolves the pending promise.
  let _connReadyResolve;
  let _connReady = conn
    ? Promise.resolve(conn)
    : new Promise((resolve) => { _connReadyResolve = resolve; });

  const CONN_WAIT_TIMEOUT_MS = opts.connWaitTimeoutMs ?? 10_000;

  /**
   * Wait for the MAP connection to become available.
   * Returns the connection or null if timed out.
   */
  async function waitForConn() {
    if (conn) return conn;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), CONN_WAIT_TIMEOUT_MS));
    return Promise.race([_connReady, timeout]);
  }

  const handler = async (command, client) => {
    const { action } = command;

    try {
      switch (action) {
        case "emit": {
          const c = conn || await waitForConn();
          if (c) {
            await c.send(
              { scope },
              command.event,
              command.meta || { relationship: "broadcast" }
            );
          }
          respond(client, { ok: true });
          break;
        }

        case "send": {
          const c = conn || await waitForConn();
          if (c) {
            await c.send(command.to, command.payload, command.meta);
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
              log.error("spawn (mesh) failed", { error: err.message });
              respond(client, { ok: false, error: err.message });
            }
          } else {
            // WebSocket mode: use MAP SDK (wait for connection if needed)
            const c = conn || await waitForConn();
            if (!c) {
              respond(client, { ok: false, error: "no connection (timed out waiting)" });
              break;
            }
            try {
              const result = await c.spawn({
                agentId,
                name,
                role,
                scopes: agentScopes,
                metadata,
              });
              registeredAgents.set(agentId, { name, role, metadata });

              // Also register in inbox storage for message routing
              if (inboxInstance?.storage) {
                try {
                  inboxInstance.storage.putAgent({
                    agent_id: agentId,
                    scope,
                    status: "active",
                    metadata: { name, role, ...metadata },
                    registered_at: new Date().toISOString(),
                    last_active_at: new Date().toISOString(),
                  });
                } catch { /* best-effort */ }
              }

              respond(client, { ok: true, agent: result });
            } catch (err) {
              log.error("spawn failed", { error: err.message });
              respond(client, { ok: false, error: err.message });
            }
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
          } else if (conn) {
            // WebSocket mode: use MAP SDK (best-effort, no wait — local cleanup is priority)
            try {
              await conn.callExtension("map/agents/unregister", {
                agentId,
                reason: reason || "completed",
              });
            } catch {
              // Agent may already be gone
            }

            // Also update inbox storage
            if (inboxInstance?.storage) {
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
          }

          // Always clean up local tracking — even if conn is null (during
          // an outage), we want to remove the agent so it isn't
          // re-registered when the connection is restored.
          registeredAgents.delete(agentId);
          respond(client, { ok: true });
          break;
        }

        case "trajectory-checkpoint": {
          const c = conn || await waitForConn();
          if (c) {
            try {
              // Include cached resource_id if available from a previous response
              const payload = { checkpoint: command.checkpoint };
              if (_trajectoryResourceId) {
                payload.resource_id = _trajectoryResourceId;
              }
              const result = await c.callExtension("trajectory/checkpoint", payload);
              // Cache resource_id from server response for subsequent calls
              if (result?.resource_id) {
                _trajectoryResourceId = result.resource_id;
              }
              respond(client, { ok: true, method: "trajectory", resource_id: result?.resource_id });
            } catch (err) {
              log.warn("trajectory/checkpoint not supported, falling back to broadcast", { error: err.message });
              await c.send(
                { scope },
                {
                  type: "trajectory.checkpoint",
                  checkpoint: {
                    id: command.checkpoint.id,
                    agent: command.checkpoint.agent,
                    session_id: command.checkpoint.session_id,
                    files_touched: command.checkpoint.files_touched,
                    token_usage: command.checkpoint.token_usage,
                    metadata: command.checkpoint.metadata,
                  },
                },
                { relationship: "broadcast" }
              );
              respond(client, { ok: true, method: "broadcast-fallback" });
            }
          } else {
            respond(client, { ok: false, error: "no connection (timed out waiting)" });
          }
          break;
        }

        // --- Task event bridge (opentasks → MAP) ---
        // These emit task events over the shared connection using
        // the opentasks event bridge pattern. Works identically in
        // both mesh and websocket modes.

        case "bridge-task-created": {
          const c = conn || await waitForConn();
          if (c) {
            try {
              await c.send({ scope }, {
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
          const c = conn || await waitForConn();
          if (c) {
            try {
              await c.send({ scope }, {
                type: "task.status",
                taskId: command.taskId,
                previous: command.previous || "open",
                current: command.current,
                _origin: command.agentId || "opentasks",
              }, { relationship: "broadcast" });
              // Also emit task.completed for terminal states
              if (command.current === "completed" || command.current === "closed") {
                await c.send({ scope }, {
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
          const c = conn || await waitForConn();
          if (c) {
            try {
              await c.send({ scope }, {
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
          const c = conn || await waitForConn();
          if (c) {
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
                await c.updateState(command.state);
                if (command.metadata) {
                  await c.updateMetadata(command.metadata);
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
      log.error("command error", { action, error: err.message });
      respond(client, { ok: false, error: err.message });
    }
  };

  // Allow updating the connection reference (also resolves any pending waitForConn)
  handler.setConnection = (newConn) => {
    conn = newConn;
    if (newConn && _connReadyResolve) {
      _connReadyResolve(newConn);
      _connReadyResolve = null;
    }
    // Reset the gate for future disconnection/reconnection cycles
    if (!newConn) {
      _connReady = new Promise((resolve) => { _connReadyResolve = resolve; });
    }
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
