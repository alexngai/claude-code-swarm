/**
 * paths.mjs — Path constants and directory helpers for claude-code-swarm
 *
 * Centralizes all file paths used by hooks, sidecar, and bootstrap.
 * Plugin-specific files live under .swarm/claude-swarm/ in the user's project root.
 * Generated/runtime artifacts go under .swarm/claude-swarm/tmp/ (gitignored).
 * Package-level dirs (.swarm/openteams/, .swarm/sessionlog/) are managed by swarmkit.
 *
 * Directory layout:
 *   .swarm/claude-swarm/config.json               — user config
 *   .swarm/claude-swarm/tmp/teams/<template>/      — per-template artifact cache
 *   .swarm/claude-swarm/tmp/map/                   — shared MAP runtime state
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

// Root plugin directory within .swarm
export const SWARM_DIR = ".swarm/claude-swarm";
export const CONFIG_PATH = ".swarm/claude-swarm/config.json";

// Global config directory (~/.claude-swarm/)
export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".claude-swarm");
export const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");

// Temporary/generated artifacts (gitignored)
export const TMP_DIR = ".swarm/claude-swarm/tmp";

// Per-template team artifact cache
export const TEAMS_DIR = ".swarm/claude-swarm/tmp/teams";

// Shared MAP runtime files (not per-template)
export const MAP_DIR = ".swarm/claude-swarm/tmp/map";
export const SOCKET_PATH = ".swarm/claude-swarm/tmp/map/sidecar.sock";
export const INBOX_PATH = ".swarm/claude-swarm/tmp/map/inbox.jsonl";
export const PID_PATH = ".swarm/claude-swarm/tmp/map/sidecar.pid";
export const ROLES_PATH = ".swarm/claude-swarm/tmp/map/roles.json";
export const SESSIONLOG_STATE_PATH = ".swarm/claude-swarm/tmp/map/sessionlog-state.json";
export const SIDECAR_LOG_PATH = ".swarm/claude-swarm/tmp/map/sidecar.log";

// External paths
export const SESSIONLOG_DIR = path.join(".git", "sessionlog-sessions");

/**
 * Get the per-template team directory.
 * E.g. teamDir("gsd") → ".swarm/claude-swarm/tmp/teams/gsd"
 */
export function teamDir(templateName) {
  return path.join(TEAMS_DIR, templateName);
}

/**
 * Ensure the .swarm/claude-swarm/ directory exists with a .gitignore for tmp/.
 */
export function ensureSwarmDir() {
  fs.mkdirSync(SWARM_DIR, { recursive: true });
  const gitignorePath = path.join(SWARM_DIR, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "tmp/\n");
  }
}

/**
 * Ensure the MAP runtime directory exists.
 */
export function ensureMapDir() {
  fs.mkdirSync(MAP_DIR, { recursive: true });
}

/**
 * Resolve the plugin root directory.
 * Works from any file in src/ or scripts/.
 */
export function pluginDir() {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..");
}
