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

    client.on("error", () => resolve(null));

    setTimeout(() => {
      client.destroy();
      resolve(null);
    }, timeoutMs);
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
        const result = await rpcRequest("graph.update", {
          uri: evt.uri,
          status: evt.status,
          title: evt.subject,
          metadata: { source: evt.source, syncedAt: new Date().toISOString() },
        }, socketPath);
        // If update fails (node doesn't exist), try creating
        if (result === null && evt.uri) {
          await rpcRequest("graph.create", {
            type: "task",
            uri: evt.uri,
            title: evt.subject || "",
            status: evt.status || "open",
            metadata: { source: evt.source, syncedAt: new Date().toISOString() },
          }, socketPath);
        }
        return true;
      }

      case "task.claimed": {
        await rpcRequest("graph.update", {
          uri: evt.uri,
          status: "in_progress",
          assignee: evt.agent,
          metadata: { source: evt.source, claimedAt: new Date().toISOString() },
        }, socketPath);
        return true;
      }

      case "task.unblocked": {
        await rpcRequest("graph.update", {
          uri: evt.uri,
          status: "open",
          metadata: { unblockedBy: evt.unblockedBy, source: evt.source },
        }, socketPath);
        return true;
      }

      case "task.linked": {
        await rpcRequest("tools.link", {
          from: evt.from,
          to: evt.to,
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
