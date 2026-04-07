/**
 * memory-watcher.mjs — Watches the minimem memory directory for file changes
 * and sends bridge-memory-sync commands to notify OpenHive via MAP.
 *
 * This bridges the gap between filesystem writes (Write tool, manual edits)
 * and MAP sync notifications. minimem's MCP tools are read-only, so this
 * watcher is the only way to detect when an agent writes to memory.
 *
 * Runs inside the MAP sidecar process (persistent for the session).
 *
 * Uses Node's built-in fs.watch (recursive) instead of chokidar to avoid
 * an external dependency. Requires Node 20+ for recursive on Linux.
 */

import { watch, existsSync } from "fs";
import { resolve } from "path";
import { createLogger } from "./log.mjs";

const log = createLogger("memory-watcher");

const DEBOUNCE_MS = 2000;

/** Patterns to ignore (matched against the relative filename). */
const IGNORED = [/node_modules/, /\.git/, /index\.db/, /\.cache/, /\.minimem/];

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
  const absDir = resolve(memoryDir);

  let watcher;
  try {
    watcher = watch(absDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Only react to .md file changes
      if (!filename.endsWith(".md")) return;

      // Skip ignored patterns
      if (IGNORED.some((re) => re.test(filename))) return;

      const fullPath = resolve(absDir, filename);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        log.debug("memory change detected", { event: eventType, path: fullPath });
        onSync({ type: eventType, path: fullPath });
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    log.warn("memory watcher failed to start", { error: err.message });
    return null;
  }

  watcher.on("error", (err) => {
    log.warn("memory watcher error", { error: err.message });
  });

  log.info("memory watcher started", { dir: memoryDir });

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      log.debug("memory watcher stopped");
    },
  };
}
