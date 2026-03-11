/**
 * cleanup.mjs — Process and file cleanup utilities for e2e tests
 */

import fs from "fs";
import path from "path";

/**
 * Kill a process by PID file. Silent on failure.
 */
export function killByPidFile(pidPath) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim());
    if (pid > 0) process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Clean up generated artifacts and sidecar processes in a workspace.
 * Kills both default and per-session sidecar processes.
 */
export function cleanupWorkspace(dir) {
  const mapDir = path.join(dir, ".swarm", "claude-swarm", "tmp", "map");

  // Kill default MAP sidecar if running
  killByPidFile(path.join(mapDir, "sidecar.pid"));

  // Kill all per-session sidecars
  const sessionsDir = path.join(mapDir, "sessions");
  try {
    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        killByPidFile(path.join(sessionsDir, entry, "sidecar.pid"));
      }
    }
  } catch {
    // ignore
  }

  // Remove all generated/tmp artifacts
  const tmpDir = path.join(dir, ".swarm", "claude-swarm", "tmp");
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Wait for a condition with timeout.
 * Returns true if predicate passed, false if timed out.
 */
export async function waitFor(predicate, timeoutMs = 5000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
