/**
 * bootstrap.mjs — SessionStart orchestration for claude-code-swarm
 *
 * Two-phase bootstrap: a fast synchronous path returns context immediately
 * (config + cached team artifacts), while slow operations (package version
 * checks, sidecar startup, project init, status probes) run in the background.
 *
 * Supports per-session sidecars: when sessionId is provided, each session
 * gets its own sidecar process with isolated socket/pid/inbox paths.
 */

import fs from "fs";
import { execSync } from "child_process";
import { readConfig, resolveScope, resolveTeamName } from "./config.mjs";
import { SOCKET_PATH, MAP_DIR, pluginDir, ensureSwarmDir, ensureOpentasksDir, ensureSessionDir, listSessionDirs } from "./paths.mjs";
import { createLogger, init as initLog } from "./log.mjs";

const log = createLogger("bootstrap");
import { findSocketPath, isDaemonAlive, ensureDaemon } from "./opentasks-client.mjs";
import { loadTeam } from "./template.mjs";
import { killSidecar, startSidecar, sendToInbox } from "./sidecar-client.mjs";
import { sendCommand } from "./map-events.mjs";
import { checkSessionlogStatus, syncSessionlog, annotateSwarmSession } from "./sessionlog.mjs";
import { resolveSwarmkit, configureNodePath } from "./swarmkit-resolver.mjs";

/**
 * Install plugin-local dependencies if not already present.
 * Installs js-yaml and swarmkit (bundled). Still needed for
 * the plugin's own code dependencies.
 */
function installLocalDeps(dir) {
  const nodeModules = `${dir}/node_modules`;
  if (fs.existsSync(nodeModules)) return;

  log.info("installing local dependencies");
  try {
    execSync("npm install --production", {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    log.warn("npm install failed", { error: err.message });
  }
}

/**
 * Determine which packages need to be installed globally based on config.
 * openteams is always needed; MAP SDK and sessionlog are conditional.
 */
function getRequiredGlobalPackages(config) {
  const packages = ["openteams"];
  if (config.map.enabled) {
    packages.push("multi-agent-protocol"); // swarmkit registry key
  }
  if (config.sessionlog.enabled) {
    packages.push("sessionlog");
  }
  if (config.opentasks?.enabled) {
    packages.push("opentasks");
  }
  if (config.inbox?.enabled) {
    packages.push("agent-inbox");
  }
  if (config.minimem?.enabled) {
    packages.push("minimem");
  }
  if (config.skilltree?.enabled) {
    packages.push("skill-tree");
  }
  if (config.mesh?.enabled) {
    packages.push("agentic-mesh");
  }
  return packages;
}

/**
 * Ensure required packages are installed globally via swarmkit.
 * Checks versions first — only installs what's missing.
 * Best-effort: warnings to stderr, never blocks the session.
 */
async function ensureGlobalPackages(config) {
  const swarmkit = await resolveSwarmkit();
  if (!swarmkit) {
    log.warn("swarmkit not available, skipping global package check");
    return;
  }

  const required = getRequiredGlobalPackages(config);

  // Check all versions in parallel (~850ms each sequential → ~850ms total)
  const checks = await Promise.allSettled(
    required.map(async (pkg) => {
      try {
        const version = await swarmkit.getInstalledVersion(pkg);
        return { pkg, version };
      } catch {
        return { pkg, version: null };
      }
    })
  );
  const missing = checks
    .map((r) => r.status === "fulfilled" ? r.value : { pkg: "unknown", version: null })
    .filter((r) => !r.version)
    .map((r) => r.pkg);

  if (missing.length === 0) return;

  log.info("installing missing packages", { packages: missing });
  try {
    const results = await swarmkit.installPackages(missing);
    for (const r of results) {
      if (r.success) {
        log.info("installed package", { package: r.package, version: r.version });
      } else {
        log.warn("failed to install package", { package: r.package, error: r.error });
      }
    }
    const installed = results.filter((r) => r.success).map((r) => r.package);
    if (installed.length > 0) {
      try {
        swarmkit.addInstalledPackages(installed);
      } catch {
        // Non-critical — swarmkit config may not be writable
      }
    }
  } catch (err) {
    log.warn("global package install failed", { error: err.message });
  }
}

/**
 * Initialize swarmkit project directories (.swarm/openteams/, .swarm/sessionlog/, .swarm/claude-swarm/).
 * Uses swarmkit's initProjectPackage() for packages that need project-level setup.
 * Falls back to ensureSwarmDir() for claude-code-swarm if swarmkit is unavailable.
 * Best-effort: warnings to stderr, never blocks the session.
 */
async function initSwarmProject(config) {
  const swarmkit = await resolveSwarmkit();
  if (!swarmkit || !swarmkit.isProjectInit || !swarmkit.initProjectPackage) {
    // Swarmkit unavailable — ensure .swarm/claude-swarm/ exists via local fallback
    ensureSwarmDir();
    return;
  }

  const cwd = process.cwd();
  const ctx = {
    cwd,
    packages: [...getRequiredGlobalPackages(config), "claude-code-swarm"],
    embeddingProvider: null,
    apiKeys: {},
    usePrefix: true,
  };

  // Init openteams project dir (.swarm/openteams/)
  if (!swarmkit.isProjectInit(cwd, "openteams")) {
    try {
      await swarmkit.initProjectPackage("openteams", ctx);
    } catch {
      // best-effort
    }
  }

  // Init sessionlog project dir (.swarm/sessionlog/) if enabled
  if (config.sessionlog.enabled && !swarmkit.isProjectInit(cwd, "sessionlog")) {
    try {
      await swarmkit.initProjectPackage("sessionlog", ctx);
    } catch {
      // best-effort
    }
  }

  // Init opentasks project dir (.swarm/opentasks/) if enabled
  if (config.opentasks?.enabled && !swarmkit.isProjectInit(cwd, "opentasks")) {
    try {
      await swarmkit.initProjectPackage("opentasks", ctx);
    } catch {
      // best-effort
    }
  }

  // Init minimem project dir (.swarm/minimem/) if enabled
  if (config.minimem?.enabled && !swarmkit.isProjectInit(cwd, "minimem")) {
    try {
      await swarmkit.initProjectPackage("minimem", ctx);
    } catch {
      // best-effort
    }
  }

  // Init skill-tree project dir (.swarm/skill-tree/) if enabled
  if (config.skilltree?.enabled && !swarmkit.isProjectInit(cwd, "skill-tree")) {
    try {
      await swarmkit.initProjectPackage("skill-tree", ctx);
    } catch {
      // best-effort
    }
  }

  // Init claude-code-swarm project dir (.swarm/claude-swarm/)
  if (!swarmkit.isProjectInit(cwd, "claude-code-swarm")) {
    try {
      await swarmkit.initProjectPackage("claude-code-swarm", ctx);
    } catch {
      // Fallback to local ensureSwarmDir() if swarmkit doesn't support this package yet
      ensureSwarmDir();
    }
  }
}

/**
 * Clean up stale session directories whose sidecar processes have died.
 * Scans MAP_DIR/sessions/ and removes directories with dead PIDs.
 * Best-effort: never throws.
 */
function cleanupStaleSessions() {
  try {
    for (const { dir, pidPath } of listSessionDirs()) {
      try {
        const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim());
        process.kill(pid, 0); // throws if process is dead
        // Process is alive — leave this session alone
      } catch {
        // Process is dead or PID file unreadable — clean up
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Start the MAP sidecar in session mode.
 * Only kills this session's sidecar (if any), not other sessions'.
 * Returns status string.
 */
async function startSessionSidecar(config, scope, dir, sessionId) {
  // Kill only this session's sidecar (if somehow already running)
  killSidecar(sessionId);

  const ok = await startSidecar(config, dir, sessionId);
  if (ok) {
    // Register the main Claude Code session agent with the MAP server
    const teamName = resolveTeamName(config);
    sendCommand(config, {
      action: "spawn",
      agent: {
        agentId: sessionId,
        name: `${teamName}-main`,
        role: "orchestrator",
        scopes: [scope],
        metadata: { isMain: true, sessionId },
      },
    }, sessionId).catch(() => {});

    return `connected (scope: ${scope})`;
  }
  return `starting (scope: ${scope})`;
}

/**
 * Check persistent sidecar status.
 * Returns status string.
 */
function checkPersistentSidecar(scope) {
  if (fs.existsSync(SOCKET_PATH)) {
    return `connected via persistent sidecar (scope: ${scope})`;
  }
  return `WARNING: persistent sidecar not running at ${SOCKET_PATH}`;
}

/**
 * Background work: package checks, sidecar startup, project init, status probes.
 * Fire-and-forget — errors go to stderr, never block the session.
 * Hooks have auto-recovery logic if sidecar isn't ready yet.
 */
export async function backgroundInit(config, scope, dir, sessionId) {
  try {
    // Parallelize: version checks + project init + sidecar startup
    const tasks = [];

    // Package version checks (slowest: ~1.7s sequential, runs in parallel here)
    tasks.push(ensureGlobalPackages(config));

    // Project directory init
    tasks.push(initSwarmProject(config));

    // MAP sidecar startup
    if (config.map.enabled) {
      if (sessionId) {
        ensureSessionDir(sessionId);
      } else {
        fs.mkdirSync(MAP_DIR, { recursive: true });
      }

      if (config.map.sidecar === "session") {
        cleanupStaleSessions();
        tasks.push(
          startSessionSidecar(config, scope, dir, sessionId).then((status) => {
            log.info("MAP sidecar status", { status });
          })
        );
      }
    }

    // Inbox registration
    if (config.map.enabled && config.inbox?.enabled) {
      const teamName = resolveTeamName(config);
      const sPaths = sessionId
        ? (await import("./paths.mjs")).sessionPaths(sessionId)
        : { inboxSocketPath: (await import("./paths.mjs")).INBOX_SOCKET_PATH };
      tasks.push(
        sendToInbox({
          action: "notify",
          event: {
            type: "agent.spawn",
            agent: {
              agentId: `${teamName}-main`,
              name: `${teamName}-main`,
              role: "orchestrator",
              scopes: [scope],
              metadata: { isMain: true, sessionId },
            },
          },
        }, sPaths.inboxSocketPath).catch(() => {})
      );
    }

    // Sessionlog sync + swarm annotation
    if (config.map.enabled && config.sessionlog.sync !== "off") {
      tasks.push(syncSessionlog(config, sessionId).catch(() => {}));
    }
    if (config.sessionlog.enabled) {
      tasks.push(annotateSwarmSession(config, sessionId).catch(() => {}));
    }

    // OpenTasks daemon
    if (config.opentasks?.enabled) {
      ensureOpentasksDir();
      if (config.opentasks?.autoStart) {
        tasks.push(ensureDaemon(config).catch(() => {}));
      }
    }

    await Promise.allSettled(tasks);
  } catch (err) {
    log.error("background init failed", { error: err.message });
  }
}

/**
 * Full bootstrap flow. Returns context object for formatting.
 *
 * Fast path (~100ms): reads config, loads cached team artifacts, returns immediately.
 * Background path (fire-and-forget): package checks, sidecar, project init.
 * When sessionId is provided, uses per-session sidecar paths.
 */
export async function bootstrap(pluginDirOverride, sessionId) {
  const dir = pluginDirOverride || pluginDir();

  // ── Fast path: must complete before returning context ──────────────

  // 0. Install local dependencies (js-yaml, swarmkit) — skipped if node_modules exists
  installLocalDeps(dir);

  // 1. Read config
  const config = readConfig();

  // 1a. Initialize logger from config (env vars still take priority)
  initLog({ ...config.log, sessionId });
  log.info("session started", { sessionId, template: config.template || "(none)" });

  // 1b. Configure NODE_PATH (global + local node_modules)
  configureNodePath(dir);

  const scope = resolveScope(config);

  // 2. Load team template if configured (fast if cached)
  let team = null;
  if (config.template) {
    try {
      const result = await loadTeam(config.template);
      if (result.success) {
        team = result;
      } else {
        log.warn("failed to load template", { template: config.template, error: result.error });
      }
    } catch (err) {
      log.warn("template loading failed", { error: err.message });
    }
  }

  // 3. Sessionlog status — actual check is slow (execSync), defer to background
  let sessionlogStatus = "not installed";
  if (config.sessionlog.enabled) {
    sessionlogStatus = "checking";
  }

  // 4. Quick MAP status — report "starting" for session sidecars (actual startup is background)
  let mapStatus = "disabled";
  if (config.map.enabled) {
    if (config.map.sidecar === "session") {
      mapStatus = `starting (scope: ${scope})`;
    } else if (config.map.sidecar === "persistent") {
      mapStatus = checkPersistentSidecar(scope);
    }
  }

  // 5. Quick status for optional integrations (actual probes are too slow for fast path)
  let opentasksStatus = "disabled";
  if (config.opentasks?.enabled) {
    opentasksStatus = "enabled";
  }

  let minimemStatus = "disabled";
  if (config.minimem?.enabled) {
    minimemStatus = "enabled";
  }

  let skilltreeStatus = "disabled";
  if (config.skilltree?.enabled) {
    skilltreeStatus = "enabled";
  }

  return {
    template: config.template,
    team,
    mapEnabled: config.map.enabled,
    mapStatus,
    meshEnabled: config.mesh?.enabled,
    sessionlogEnabled: config.sessionlog.enabled,
    sessionlogStatus,
    sessionlogSync: config.sessionlog.sync,
    opentasksEnabled: config.opentasks?.enabled,
    opentasksStatus,
    inboxEnabled: config.inbox?.enabled,
    minimemEnabled: config.minimem?.enabled,
    minimemStatus,
    skilltreeEnabled: config.skilltree?.enabled,
    skilltreeStatus,
    sessionId,
  };
}
