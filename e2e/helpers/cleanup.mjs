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
 */
export function cleanupWorkspace(dir) {
  // Kill MAP sidecar if running
  const pidPath = path.join(dir, ".swarm", "claude-swarm", "tmp", "map", "sidecar.pid");
  killByPidFile(pidPath);

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
