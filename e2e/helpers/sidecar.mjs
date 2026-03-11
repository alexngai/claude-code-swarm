/**
 * sidecar.mjs — Test helper for starting/stopping real sidecar processes
 *
 * Spawns the actual map-sidecar.mjs as a detached child process,
 * waits for sockets to appear, and provides cleanup.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../..");
const SIDECAR_SCRIPT = path.join(PLUGIN_DIR, "scripts", "map-sidecar.mjs");

/**
 * Send a command to a UNIX socket and return the parsed response.
 * Longer timeout than production (5s) for test reliability.
 */
export function sendCommand(socketPath, command, timeoutMs = 5000) {
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
    }, timeoutMs);
  });
}

/**
 * Wait for a condition to become true, polling at intervalMs.
 */
async function waitFor(predicate, timeoutMs = 10000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Compute the expected socket paths for a sidecar running in a workspace.
 * Mirrors the path resolution in src/paths.mjs when .swarm/claude-swarm/ exists.
 */
function getSocketPaths(workspaceDir, sessionId) {
  // Resolve symlinks (macOS: /tmp -> /private/tmp) so paths match the sidecar's process.cwd()
  const realDir = fs.realpathSync(workspaceDir);
  const mapDir = path.join(realDir, ".swarm", "claude-swarm", "tmp", "map");
  if (sessionId) {
    const dir = path.join(mapDir, "sessions", sessionId);
    return {
      socketPath: path.join(dir, "sidecar.sock"),
      inboxSocketPath: path.join(dir, "inbox.sock"),
      pidPath: path.join(dir, "sidecar.pid"),
      mapDir,
    };
  }
  return {
    socketPath: path.join(mapDir, "sidecar.sock"),
    inboxSocketPath: path.join(mapDir, "inbox.sock"),
    pidPath: path.join(mapDir, "sidecar.pid"),
    mapDir,
  };
}

/**
 * Start the real sidecar process for testing.
 *
 * @param {object} options
 * @param {string} options.workspaceDir - workspace with .swarm/claude-swarm/ directory
 * @param {number} options.mockServerPort - port of the mock MAP server
 * @param {string} [options.scope] - MAP scope (default: "swarm:test")
 * @param {string} [options.systemId] - system ID (default: "system-test")
 * @param {string} [options.sessionId] - per-session sidecar ID
 * @param {object} [options.inboxConfig] - inbox config object (passed as --inbox-config JSON)
 * @param {number} [options.inactivityTimeoutMs] - inactivity timeout override
 * @returns {Promise<object>} handle with socketPath, pid, cleanup, etc.
 */
export async function startTestSidecar(options) {
  const {
    workspaceDir,
    mockServerPort,
    scope = "swarm:test",
    systemId = "system-test",
    sessionId,
    inboxConfig,
    inactivityTimeoutMs,
  } = options;

  const paths = getSocketPaths(workspaceDir, sessionId);

  // Ensure map directory exists
  fs.mkdirSync(path.dirname(paths.pidPath), { recursive: true });

  // Build CLI args
  const args = [
    SIDECAR_SCRIPT,
    "--server", `ws://localhost:${mockServerPort}`,
    "--scope", scope,
    "--system-id", systemId,
  ];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (inboxConfig) {
    args.push("--inbox-config", JSON.stringify(inboxConfig));
  }
  if (inactivityTimeoutMs) {
    args.push("--inactivity-timeout", String(inactivityTimeoutMs));
  }

  // Spawn detached
  const child = spawn("node", args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    cwd: workspaceDir,
  });
  child.unref();

  // Collect stderr for debugging
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  // Write PID file
  fs.writeFileSync(paths.pidPath, String(child.pid));

  // Wait for lifecycle socket to appear and respond to ping
  const lifecycleReady = await waitFor(async () => {
    if (!fs.existsSync(paths.socketPath)) return false;
    const resp = await sendCommand(paths.socketPath, { action: "ping" });
    return resp?.ok === true;
  }, 15000);

  if (!lifecycleReady) {
    // Try to clean up
    try { process.kill(child.pid, "SIGTERM"); } catch { /* ignore */ }
    throw new Error(
      `Sidecar lifecycle socket not ready after 15s.\nStderr: ${stderr}`
    );
  }

  // If inbox is configured, wait for inbox socket too
  let inboxReady = false;
  if (inboxConfig) {
    inboxReady = await waitFor(
      () => fs.existsSync(paths.inboxSocketPath),
      10000
    );
  }

  return {
    pid: child.pid,
    child,
    stderr: () => stderr,
    ...paths,
    inboxReady,
    cleanup: () => stopTestSidecar({ pid: child.pid, ...paths }),
  };
}

/**
 * Stop a test sidecar and clean up.
 */
export async function stopTestSidecar(handle) {
  const { pid, socketPath, inboxSocketPath, pidPath } = handle;

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already dead
  }

  // Wait for process to die
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000);

  // Clean up files
  for (const f of [socketPath, inboxSocketPath, pidPath]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * Check if a process is alive.
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
