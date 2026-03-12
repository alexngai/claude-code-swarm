/**
 * opentasks-client.mjs — Daemon IPC client for opentasks integration
 *
 * Speaks JSON-RPC 2.0 over Unix socket to the opentasks daemon.
 * Provides lifecycle management (discovery, health check, auto-start)
 * and graph operations for forwarding MAP sync events.
 *
 * Pattern: src/sidecar-client.mjs (never-throw, best-effort, timeouts)
 * Key difference: JSON-RPC 2.0 (request/response with id) vs sidecar's
 * fire-and-forget NDJSON.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { OPENTASKS_DIR } from "./paths.mjs";

/**
 * Discover the opentasks daemon socket path.
 * Priority:
 *   1. .swarm/opentasks/daemon.sock (swarmkit layout)
 *   2. .opentasks/daemon.sock (walk up directory tree)
 *   3. .git/opentasks/daemon.sock (git multi-location)
 *
 * Returns the first path that exists, or the swarmkit default.
 */
export function findSocketPath() {
  const candidates = [
    path.join(".swarm", "opentasks", "daemon.sock"),
    path.join(".opentasks", "daemon.sock"),
    path.join(".git", "opentasks", "daemon.sock"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Walk up for .opentasks/daemon.sock
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    const sock = path.join(dir, ".opentasks", "daemon.sock");
    if (fs.existsSync(sock)) return sock;
    dir = path.dirname(dir);
  }

  // Default to swarmkit layout (will be created by ensureDaemon)
  return path.join(".swarm", "opentasks", "daemon.sock");
}

/**
 * Send a JSON-RPC 2.0 request to the opentasks daemon.
 * Returns the result on success, null on any failure. Never throws.
 *
 * @param {string} method - JSON-RPC method name (e.g., "ping", "graph.update")
 * @param {object} params - Method parameters
 * @param {string} [socketPath] - Unix socket path (auto-discovered if omitted)
 * @param {number} [timeoutMs=2000] - Request timeout in milliseconds
 * @returns {Promise<object|null>} Result payload or null on failure
 */
export function rpcRequest(method, params = {}, socketPath, timeoutMs = 2000) {
  const sock = socketPath || findSocketPath();

  return new Promise((resolve) => {
    const id = randomUUID();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }) + "\n";

    let buffer = "";
    const client = net.createConnection(sock, () => {
      client.write(request);
    });

    client.on("data", (data) => {
      buffer += data.toString();
      // Try to parse complete response
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            clearTimeout(timer);
            client.destroy();
            if (response.error) {
              resolve(null);
            } else {
              resolve(response.result ?? {});
            }
            return;
          }
        } catch {
          // Incomplete JSON, wait for more data
        }
      }
    });

    client.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    const timer = setTimeout(() => {
      client.destroy();
      resolve(null);
    }, timeoutMs);
    // Don't let this timer keep the hook process alive after response
    timer.unref();
  });
}

/**
 * Check if the opentasks daemon is alive via ping.
 * Returns true if responsive. Never throws.
 */
export async function isDaemonAlive(socketPath) {
  const result = await rpcRequest("ping", {}, socketPath);
  return result !== null;
}

/**
 * Ensure the opentasks daemon is running.
 * If not alive, attempts to start via `opentasks daemon start`.
 * Returns true if daemon is available after this call.
 */
export async function ensureDaemon(config) {
  const socketPath = findSocketPath();

  // 1. Check if already alive
  if (await isDaemonAlive(socketPath)) return true;

  // 2. Try to start the daemon
  try {
    fs.mkdirSync(OPENTASKS_DIR, { recursive: true });

    const child = spawn("opentasks", ["daemon", "start"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    child.unref();

    // Collect stderr briefly for diagnostics
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    // Wait for socket to appear (up to 3s)
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isDaemonAlive(socketPath)) return true;
    }

    if (stderr) {
      process.stderr.write(`[opentasks-client] Daemon start stderr: ${stderr.trim()}\n`);
    }
  } catch (err) {
    process.stderr.write(`[opentasks-client] Failed to start daemon: ${err.message}\n`);
  }

  return false;
}

/**
 * Create a task in the opentasks graph.
 * Returns the created node or null on failure.
 *
 * @param {string} socketPath - Daemon socket path
 * @param {object} params - { type, title, status, assignee?, metadata? }
 * @returns {Promise<object|null>}
 */
export async function createTask(socketPath, params) {
  return rpcRequest("graph.create", {
    type: "task",
    ...params,
  }, socketPath);
}

/**
 * Update a task in the opentasks graph.
 * Returns the updated node or null on failure.
 *
 * @param {string} socketPath - Daemon socket path
 * @param {string} id - Node ID
 * @param {object} updates - { status?, title?, assignee?, metadata? }
 * @returns {Promise<object|null>}
 */
export async function updateTask(socketPath, id, updates) {
  return rpcRequest("graph.update", { id, ...updates }, socketPath);
}

/**
 * Forward a MAP task sync event to the opentasks graph.
 * Translates MAP task.* event payloads into opentasks graph operations.
 * Best-effort: returns true on success, false on failure. Never throws.
 *
 * @param {string} socketPath - Daemon socket path
 * @param {object} evt - MAP task event payload (e.g., { type: "task.sync", uri: "...", status: "..." })
 * @returns {Promise<boolean>}
 */
export async function pushSyncEvent(socketPath, evt) {
  try {
    switch (evt.type) {
      case "task.sync": {
        // Try to find and update existing node by querying for it
        // If we have an ID, update directly; otherwise create
        if (evt.id) {
          const result = await rpcRequest("graph.update", {
            id: evt.id,
            status: evt.status,
            title: evt.subject,
            metadata: { source: evt.source, syncedAt: new Date().toISOString() },
          }, socketPath);
          if (result !== null) return true;
        }
        // Create new node
        await rpcRequest("graph.create", {
          type: "task",
          uri: evt.uri,
          title: evt.subject || "",
          status: evt.status || "open",
          metadata: { source: evt.source, syncedAt: new Date().toISOString() },
        }, socketPath);
        return true;
      }

      case "task.claimed": {
        if (!evt.id) return false;
        await rpcRequest("graph.update", {
          id: evt.id,
          status: "in_progress",
          assignee: evt.agent,
          metadata: { source: evt.source, claimedAt: new Date().toISOString() },
        }, socketPath);
        return true;
      }

      case "task.unblocked": {
        if (!evt.id) return false;
        await rpcRequest("graph.update", {
          id: evt.id,
          status: "open",
          metadata: { unblockedBy: evt.unblockedBy, source: evt.source },
        }, socketPath);
        return true;
      }

      case "task.linked": {
        await rpcRequest("tools.link", {
          fromId: evt.from,
          toId: evt.to,
          type: evt.linkType || "related",
          metadata: { source: evt.source },
        }, socketPath);
        return true;
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
}
