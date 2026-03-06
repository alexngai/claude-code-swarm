/**
 * sidecar-client.mjs — UNIX socket client for communicating with the MAP sidecar
 *
 * Provides send, health check, and recovery logic used by hooks.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { spawn } from "child_process";
import { SOCKET_PATH, PID_PATH, pluginDir } from "./paths.mjs";
import { resolveScope, resolveMapServer, DEFAULTS } from "./config.mjs";

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
export function isSidecarAlive() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the sidecar as a detached background process.
 * Writes PID file and waits for socket to appear (up to 2s).
 * Returns true if sidecar is ready.
 */
export async function startSidecar(config, pluginDirOverride) {
  const dir = pluginDirOverride || pluginDir();
  const sidecarPath = path.join(dir, "scripts", "map-sidecar.mjs");

  const server = resolveMapServer(config);
  const scope = resolveScope(config);
  const systemId = config.map?.systemId || DEFAULTS.mapSystemId;

  try {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });

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
    process.stderr.write(`[sidecar-client] Start failed: ${err.message}\n`);
  }

  return false;
}

/**
 * Kill an existing sidecar process (for session restart).
 */
export function killSidecar() {
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim());
    process.kill(pid);
  } catch {
    // Process already dead or PID file missing
  }
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }
}

/**
 * Ensure the sidecar is running. If not, attempt recovery.
 * Returns true if sidecar is available after this call.
 */
export async function ensureSidecar(config) {
  // 1. Try pinging
  const alive = await sendToSidecar({ action: "ping" });
  if (alive) return true;

  // 2. Only attempt recovery in session mode
  if (config.map?.sidecar === "persistent") return false;

  // 3. Check PID
  if (isSidecarAlive()) {
    // Process exists but socket not ready — wait briefly
    await new Promise((r) => setTimeout(r, 500));
    return sendToSidecar({ action: "ping" });
  }

  // 4. Restart sidecar
  return startSidecar(config);
}
