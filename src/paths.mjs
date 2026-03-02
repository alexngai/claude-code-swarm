/**
 * paths.mjs — Path constants and directory helpers for claude-code-swarm
 *
 * Centralizes all generated file paths used by hooks, sidecar, and bootstrap.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Generated runtime files
export const GENERATED_DIR = ".generated";
export const MAP_DIR = ".generated/map";
export const SOCKET_PATH = ".generated/map/sidecar.sock";
export const INBOX_PATH = ".generated/map/inbox.jsonl";
export const PID_PATH = ".generated/map/sidecar.pid";
export const ROLES_PATH = ".generated/map/roles.json";
export const SESSIONLOG_STATE_PATH = ".generated/map/sessionlog-state.json";
export const SIDECAR_LOG_PATH = ".generated/map/sidecar.log";

// External paths
export const CONFIG_PATH = ".claude-swarm.json";
export const SESSIONLOG_DIR = path.join(".git", "sessionlog-sessions");

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
