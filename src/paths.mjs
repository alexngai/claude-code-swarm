/**
 * paths.mjs — Path constants and directory helpers for claude-code-swarm
 *
 * Centralizes all file paths used by hooks, sidecar, and bootstrap.
 *
 * Path resolution priority:
 *   1. If .swarm/claude-swarm/ exists in CWD → use project-level paths
 *   2. Otherwise → use global paths at ~/.claude-swarm/tmp/
 *
 * Global layout:
 *   ~/.claude-swarm/tmp/teams/<template>/   — shared template artifact cache
 *   ~/.claude-swarm/tmp/map/<cwd-hash>/     — per-project MAP runtime state
 *   ~/.claude-swarm/tmp/logs/<sessionId>.log — per-session log files
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

// Global config directory (~/.claude-swarm/)
export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".claude-swarm");
export const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");

export const SESSIONLOG_DIR = path.join(".git", "sessionlog-sessions");

// --- Global base directory ---

const GLOBAL_BASE = GLOBAL_CONFIG_DIR;

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
 * Otherwise, use global paths at ~/.claude-swarm/tmp/.
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
export const INBOX_SOCKET_PATH = path.join(_mapDir, "inbox.sock");
export const PID_PATH = path.join(_mapDir, "sidecar.pid");
export const ROLES_PATH = path.join(_mapDir, "roles.json");
export const SESSIONLOG_STATE_PATH = path.join(_mapDir, "sessionlog-state.json");
export const SIDECAR_LOG_PATH = path.join(_mapDir, "sidecar.log");
export const LOG_PATH = path.join(GLOBAL_CONFIG_DIR, "tmp", "logs", "swarm.log");
export const LOGS_DIR = path.join(GLOBAL_CONFIG_DIR, "tmp", "logs");

// opentasks runtime state
export const OPENTASKS_DIR = path.join(_tmpDir, "opentasks");
export const OPENTASKS_SYNC_STATE_PATH = path.join(_tmpDir, "opentasks", "sync-state.json");

/**
 * Whether paths resolved to global (~/.claude-swarm/tmp/) vs project-level.
 */
export const IS_GLOBAL_PATHS = _isGlobal;

// --- Functions ---

/**
 * Get the per-template team directory.
 * E.g. teamDir("gsd") → ".swarm/claude-swarm/tmp/teams/gsd" or
 *      "~/.claude-swarm/tmp/teams/gsd"
 */
export function teamDir(templateName) {
  return path.join(TEAMS_DIR, templateName);
}

/**
 * Ensure the necessary directories exist.
 * - Project-level: creates .swarm/claude-swarm/ with .gitignore for tmp/
 * - Global: creates ~/.claude-swarm/tmp/ (no .gitignore needed)
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
 * Ensure the opentasks runtime directory exists.
 */
export function ensureOpentasksDir() {
  fs.mkdirSync(OPENTASKS_DIR, { recursive: true });
}

/**
 * Resolve the plugin root directory.
 * Works from any file in src/ or scripts/.
 */
export function pluginDir() {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..");
}

// --- Per-session MAP paths ---

/**
 * Compute per-session MAP sidecar paths.
 * When sessionId is provided, scopes files to MAP_DIR/sessions/<sessionId>/.
 * When sessionId is null/undefined, returns the fixed legacy paths
 * (used by persistent sidecar mode or when session ID is unavailable).
 *
 * Long session IDs (>12 chars) are hashed to avoid Unix socket path length limits (~104 chars on macOS).
 */
export function sessionPaths(sessionId) {
  if (!sessionId) {
    return {
      socketPath: SOCKET_PATH,
      inboxSocketPath: INBOX_SOCKET_PATH,
      pidPath: PID_PATH,
      sidecarLogPath: SIDECAR_LOG_PATH,
      sessionDir: null,
    };
  }
  const safeId = sessionId.length > 12
    ? createHash("sha256").update(sessionId).digest("hex").slice(0, 12)
    : sessionId;
  const dir = path.join(_mapDir, "sessions", safeId);
  return {
    socketPath: path.join(dir, "sidecar.sock"),
    inboxSocketPath: path.join(dir, "inbox.sock"),
    pidPath: path.join(dir, "sidecar.pid"),
    sidecarLogPath: path.join(dir, "sidecar.log"),
    sessionDir: dir,
  };
}

/**
 * Ensure the per-session MAP directory exists.
 * Falls back to creating MAP_DIR when sessionId is null.
 */
export function ensureSessionDir(sessionId) {
  const { sessionDir } = sessionPaths(sessionId);
  if (sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
  } else {
    fs.mkdirSync(MAP_DIR, { recursive: true });
  }
}

/**
 * List all session directories under MAP_DIR/sessions/.
 * Returns array of { sessionId, dir, pidPath }.
 * Used for stale session cleanup.
 */
export function listSessionDirs() {
  const sessionsDir = path.join(_mapDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    return fs.readdirSync(sessionsDir)
      .filter((d) => {
        try {
          return fs.statSync(path.join(sessionsDir, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((d) => ({
        sessionId: d,
        dir: path.join(sessionsDir, d),
        pidPath: path.join(sessionsDir, d, "sidecar.pid"),
      }));
  } catch {
    return [];
  }
}
