/**
 * paths.mjs — Path constants and directory helpers for claude-code-swarm
 *
 * Centralizes all file paths used by hooks, sidecar, and bootstrap.
 *
 * Path resolution priority:
 *   1. If .swarm/claude-swarm/ exists in CWD → use project-level paths
 *   2. Otherwise → use global paths at ~/.claude/claude-swarm/tmp/
 *
 * Global layout:
 *   ~/.claude/claude-swarm/tmp/teams/<template>/   — shared template artifact cache
 *   ~/.claude/claude-swarm/tmp/map/<cwd-hash>/     — per-project MAP runtime state
 *
 * Project layout (backward-compatible):
 *   .swarm/claude-swarm/config.json                — user config (always project-relative)
 *   .swarm/claude-swarm/tmp/teams/<template>/      — per-template artifact cache
 *   .swarm/claude-swarm/tmp/map/                   — MAP runtime state
 */

import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// --- Fixed paths (always project-relative) ---

export const SWARM_DIR = ".swarm/claude-swarm";
export const CONFIG_PATH = ".swarm/claude-swarm/config.json";
export const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".claude-swarm", "config.json");
export const SESSIONLOG_DIR = path.join(".git", "sessionlog-sessions");

// --- Global base directory ---

const GLOBAL_BASE = path.join(os.homedir(), ".claude", "claude-swarm");

// --- Path resolution ---

/**
 * Compute a short hash of the current working directory.
 * Used to scope MAP runtime files per-project when using global paths.
 */
function cwdHash() {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

/**
 * Resolve the base tmp directory.
 * If .swarm/claude-swarm/ exists in CWD, use project-level paths.
 * Otherwise, use global paths at ~/.claude/claude-swarm/tmp/.
 */
function resolveBaseTmpDir() {
  if (fs.existsSync(SWARM_DIR)) {
    return path.join(SWARM_DIR, "tmp");
  }
  return path.join(GLOBAL_BASE, "tmp");
}

/**
 * Resolve the MAP runtime directory.
 * When using global paths, scope by CWD hash for per-project isolation.
 * When using project-level paths, no hash needed (already project-scoped).
 */
function resolveMapDir(baseTmpDir) {
  if (baseTmpDir.startsWith(GLOBAL_BASE)) {
    return path.join(baseTmpDir, "map", cwdHash());
  }
  return path.join(baseTmpDir, "map");
}

/**
 * Whether we're using global paths (vs project-level).
 */
function isGlobal(baseTmpDir) {
  return baseTmpDir.startsWith(GLOBAL_BASE);
}

// --- Computed path constants ---

const _tmpDir = resolveBaseTmpDir();
const _mapDir = resolveMapDir(_tmpDir);
const _isGlobal = isGlobal(_tmpDir);

export const TMP_DIR = _tmpDir;
export const TEAMS_DIR = path.join(_tmpDir, "teams");
export const MAP_DIR = _mapDir;
export const SOCKET_PATH = path.join(_mapDir, "sidecar.sock");
export const INBOX_PATH = path.join(_mapDir, "inbox.jsonl");
export const PID_PATH = path.join(_mapDir, "sidecar.pid");
export const ROLES_PATH = path.join(_mapDir, "roles.json");
export const SESSIONLOG_STATE_PATH = path.join(_mapDir, "sessionlog-state.json");
export const SIDECAR_LOG_PATH = path.join(_mapDir, "sidecar.log");

/**
 * Whether paths resolved to global (~/.claude/claude-swarm/tmp/) vs project-level.
 */
export const IS_GLOBAL_PATHS = _isGlobal;

// --- Functions ---

/**
 * Get the per-template team directory.
 * E.g. teamDir("gsd") → ".swarm/claude-swarm/tmp/teams/gsd" or
 *      "~/.claude/claude-swarm/tmp/teams/gsd"
 */
export function teamDir(templateName) {
  return path.join(TEAMS_DIR, templateName);
}

/**
 * Ensure the necessary directories exist.
 * - Project-level: creates .swarm/claude-swarm/ with .gitignore for tmp/
 * - Global: creates ~/.claude/claude-swarm/tmp/ (no .gitignore needed)
 */
export function ensureSwarmDir() {
  if (_isGlobal) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } else {
    fs.mkdirSync(SWARM_DIR, { recursive: true });
    const gitignorePath = path.join(SWARM_DIR, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "tmp/\n");
    }
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
