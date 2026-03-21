/**
 * sidecar-client.mjs — UNIX socket client for communicating with the MAP sidecar
 *
 * Provides send, health check, and recovery logic used by hooks.
 * Supports per-session sidecar instances via sessionId parameter.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { spawn } from "child_process";
import { SOCKET_PATH, PID_PATH, pluginDir, sessionPaths } from "./paths.mjs";
import { resolveScope, resolveMapServer, DEFAULTS } from "./config.mjs";
import { meshFireAndForget } from "./mesh-connection.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger("sidecar-client");

/**
 * Send a command to the agent-inbox IPC socket and return the response.
 * Returns the parsed response or null on failure. Never throws.
 */
export function sendToInbox(command, socketPath) {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + "\n");
    });
    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve(null);
        }
      }
    });
    client.on("error", () => resolve(null));
    setTimeout(() => {
      client.destroy();
      resolve(null);
    }, 2000);
  });
}

/**
 * Send a command to the sidecar via UNIX socket.
 * Returns true if successful, false otherwise. Never throws.
 */
export function sendToSidecar(command, socketPath = SOCKET_PATH) {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + "\n");
      client.end();
      resolve(true);
    });
    client.on("error", () => resolve(false));
    setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
  });
}

/**
 * Check if the sidecar process is alive via PID file.
 */
export function isSidecarAlive(pidPath = PID_PATH) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the sidecar as a detached background process.
 * Writes PID file and waits for socket to appear (up to 2s).
 * When sessionId is provided, the sidecar uses per-session paths.
 * Returns true if sidecar is ready.
 */
export async function startSidecar(config, pluginDirOverride, sessionId) {
  const dir = pluginDirOverride || pluginDir();
  const sidecarPath = path.join(dir, "scripts", "map-sidecar.mjs");
  const sPaths = sessionPaths(sessionId);

  const server = resolveMapServer(config, sessionId);
  const scope = resolveScope(config);
  const systemId = config.map?.systemId || DEFAULTS.mapSystemId;

  try {
    fs.mkdirSync(path.dirname(sPaths.pidPath), { recursive: true });

    const args = [sidecarPath, "--server", server, "--scope", scope, "--system-id", systemId];
    if (sessionId) {
      args.push("--session-id", sessionId);
    }
    // Pass auth credential for server-driven auth negotiation
    const credential = config.map?.auth?.credential;
    if (credential) {
      args.push("--credential", credential);
    }
    if (config.inbox?.enabled) {
      args.push("--inbox-config", JSON.stringify(config.inbox));
    }
    if (config.map?.reconnectIntervalMs && config.map.reconnectIntervalMs !== DEFAULTS.mapReconnectIntervalMs) {
      args.push("--reconnect-interval", String(config.map.reconnectIntervalMs));
    }
    if (config.mesh?.enabled) {
      args.push("--mesh-enabled");
      if (config.mesh.peerId) {
        args.push("--mesh-peer-id", config.mesh.peerId);
      }
    }

    const child = spawn("node", args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    fs.writeFileSync(sPaths.pidPath, String(child.pid));

    // Wait for socket to appear (up to 2s)
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (fs.existsSync(sPaths.socketPath)) {
        const ok = await sendToSidecar({ action: "ping" }, sPaths.socketPath);
        if (ok) return true;
      }
    }
  } catch (err) {
    log.error("start failed", { error: err.message });
  }

  return false;
}

/**
 * Kill an existing sidecar process (for session restart).
 * When sessionId is provided, kills only that session's sidecar.
 */
export function killSidecar(sessionId) {
  const sPaths = sessionPaths(sessionId);
  try {
    const pid = parseInt(fs.readFileSync(sPaths.pidPath, "utf-8").trim());
    process.kill(pid);
  } catch {
    // Process already dead or PID file missing
  }
  try {
    fs.unlinkSync(sPaths.pidPath);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(sPaths.socketPath);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(sPaths.inboxSocketPath);
  } catch {
    // ignore
  }
}

/**
 * Ensure the sidecar is running. If not, attempt recovery.
 * Returns true if sidecar is available after this call.
 */
export async function ensureSidecar(config, sessionId) {
  const sPaths = sessionPaths(sessionId);

  // 1. Try pinging
  const alive = await sendToSidecar({ action: "ping" }, sPaths.socketPath);
  if (alive) return true;

  // 2. Only attempt recovery in session mode
  if (config.map?.sidecar === "persistent") return false;

  // 3. Check PID
  if (isSidecarAlive(sPaths.pidPath)) {
    // Process exists but socket not ready — wait briefly
    await new Promise((r) => setTimeout(r, 500));
    return sendToSidecar({ action: "ping" }, sPaths.socketPath);
  }

  // 4. Restart sidecar
  return startSidecar(config, undefined, sessionId);
}
