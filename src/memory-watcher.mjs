/**
 * memory-watcher.mjs — Watches the minimem memory directory for file changes
 * and sends bridge-memory-sync commands to notify OpenHive via MAP.
 *
 * This bridges the gap between filesystem writes (Write tool, manual edits)
 * and MAP sync notifications. minimem's MCP tools are read-only, so this
 * watcher is the only way to detect when an agent writes to memory.
 *
 * Runs inside the MAP sidecar process (persistent for the session).
 */

import chokidar from "chokidar";
import { existsSync } from "fs";
import { createLogger } from "./log.mjs";

const log = createLogger("memory-watcher");

const DEBOUNCE_MS = 2000;

/**
 * Start watching a minimem directory for file changes.
 * When changes are detected (debounced), calls the provided callback.
 *
 * @param {string} memoryDir - Path to the minimem directory (e.g., ".swarm/minimem")
 * @param {(event: { type: string; path: string }) => void} onSync - Called when sync should be emitted
 * @returns {{ close: () => void } | null} Watcher handle, or null if directory doesn't exist
 */
export function startMemoryWatcher(memoryDir, onSync) {
  if (!memoryDir || !existsSync(memoryDir)) {
    log.debug("memory watcher skipped — directory not found", { dir: memoryDir });
    return null;
  }

  let debounceTimer = null;

  const watcher = chokidar.watch(memoryDir, {
    ignoreInitial: true,
    ignored: [/node_modules/, /\.git/, /index\.db/, /\.cache/, /\.minimem/],
    depth: 3,
  });

  function debouncedSync(eventType, filePath) {
    // Only react to .md file changes
    if (!filePath.endsWith(".md")) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      log.debug("memory change detected", { event: eventType, path: filePath });
      onSync({ type: eventType, path: filePath });
    }, DEBOUNCE_MS);
  }

  watcher.on("add", (p) => debouncedSync("add", p));
  watcher.on("change", (p) => debouncedSync("change", p));
  watcher.on("unlink", (p) => debouncedSync("unlink", p));

  watcher.on("ready", () => {
    log.info("memory watcher started", { dir: memoryDir });
  });

  watcher.on("error", (err) => {
    log.warn("memory watcher error", { error: err.message });
  });

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      log.debug("memory watcher stopped");
    },
  };
}
