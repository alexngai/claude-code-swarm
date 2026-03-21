/**
 * log.mjs — Structured logging for claude-code-swarm
 *
 * Provides leveled, module-tagged logging with JSON Lines file output
 * and human-readable stderr output. Supports per-session log files.
 *
 * Usage:
 *   import { createLogger } from "./log.mjs";
 *   const log = createLogger("bootstrap");
 *   log.info("template loaded", { template: "gsd" });
 *
 * Configuration (env vars take priority over init() values):
 *   SWARM_LOG_LEVEL  — error | warn | info | debug (default: warn)
 *   SWARM_LOG_FILE   — explicit log file path (overrides everything)
 *   SWARM_LOG_DIR    — log directory for per-session files (default: ~/.claude-swarm/tmp/logs/)
 *   SWARM_LOG_STDERR — true | false (default: true)
 *
 * Per-session logs:
 *   When init() is called with a sessionId, logs go to <dir>/<sessionId>.log.
 *   Default dir is ~/.claude-swarm/tmp/logs/ (always global).
 *   SWARM_LOG_FILE overrides per-session paths entirely.
 */

import fs from "fs";
import path from "path";
import { LOG_PATH, LOGS_DIR } from "./paths.mjs";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Resolved lazily on first log call
let _level;
let _logFile;
let _logsDir;
let _stderr;
let _initialized = false;

/**
 * Resolve config from env vars (called lazily on first write).
 * Env vars are always authoritative — init() only fills in gaps.
 */
function resolveFromEnv() {
  if (_initialized) return;
  _initialized = true;
  _level = LEVELS[process.env.SWARM_LOG_LEVEL?.toLowerCase()] ?? LEVELS.warn;
  _logFile = process.env.SWARM_LOG_FILE || LOG_PATH;
  _logsDir = process.env.SWARM_LOG_DIR || LOGS_DIR;
  _stderr = process.env.SWARM_LOG_STDERR !== "false";
}

/**
 * Resolve the log file path for a session.
 * Returns <logsDir>/<sessionId>.log, creating the directory if needed.
 */
function sessionLogPath(sessionId, logsDir) {
  const dir = logsDir || _logsDir || LOGS_DIR;
  const logPath = path.join(dir, `${sessionId}.log`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort — write() will also silently fail if dir doesn't exist
  }
  return logPath;
}

/**
 * Apply config-file values and session context after readConfig() completes.
 * Call from bootstrap / hook entry points. Env vars still take priority.
 *
 * @param {object} [opts]
 * @param {string} [opts.level] - "error" | "warn" | "info" | "debug"
 * @param {string} [opts.file]  - Log file path (overrides session-based path)
 * @param {string} [opts.dir]   - Log directory for per-session files
 * @param {boolean} [opts.stderr] - Also write to stderr
 * @param {string} [opts.sessionId] - Session ID for per-session log files
 */
export function init({ level, file, dir, stderr, sessionId } = {}) {
  resolveFromEnv();
  if (!process.env.SWARM_LOG_LEVEL && level && LEVELS[level] !== undefined) {
    _level = LEVELS[level];
  }
  if (!process.env.SWARM_LOG_DIR && dir) {
    _logsDir = dir;
  }
  if (process.env.SWARM_LOG_FILE) {
    // Env var is authoritative — don't override
  } else if (file) {
    _logFile = file;
  } else if (sessionId) {
    _logFile = sessionLogPath(sessionId, _logsDir);
  }
  if (process.env.SWARM_LOG_STDERR === undefined && stderr !== undefined) {
    _stderr = Boolean(stderr);
  }
}

/**
 * Reset internal state. Exported for testing only.
 */
export function _reset() {
  _level = undefined;
  _logFile = undefined;
  _logsDir = undefined;
  _stderr = undefined;
  _initialized = false;
}

/**
 * Write a log entry. Best-effort — never throws.
 */
function write(level, mod, msg, data) {
  resolveFromEnv();
  if (LEVELS[level] > _level) return;

  // JSON Lines to file
  if (_logFile) {
    const base = { ts: new Date().toISOString(), level, mod, msg };
    const entry = data && Object.keys(data).length > 0
      ? JSON.stringify({ ...base, data })
      : JSON.stringify(base);
    try {
      fs.appendFileSync(_logFile, entry + "\n");
    } catch {
      // Best-effort — dir may not exist yet during early bootstrap
    }
  }

  // Human-readable to stderr
  if (_stderr) {
    const extra = data && Object.keys(data).length > 0
      ? " " + JSON.stringify(data)
      : "";
    process.stderr.write(`[${mod}:${level}] ${msg}${extra}\n`);
  }
}

/**
 * Create a logger scoped to a module name.
 *
 * @param {string} mod - Module identifier (e.g. "bootstrap", "sidecar", "mesh")
 * @returns {{ error, warn, info, debug }} Logger methods
 */
export function createLogger(mod) {
  return {
    error: (msg, data) => write("error", mod, msg, data),
    warn:  (msg, data) => write("warn",  mod, msg, data),
    info:  (msg, data) => write("info",  mod, msg, data),
    debug: (msg, data) => write("debug", mod, msg, data),
  };
}
