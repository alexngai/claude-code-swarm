/**
 * bootstrap.mjs — SessionStart orchestration for claude-code-swarm
 *
 * Reads config, installs local deps (js-yaml, swarmkit), ensures global
 * packages via swarmkit (openteams, MAP SDK, sessionlog), starts MAP
 * sidecar if configured, runs initial sessionlog sync.
 * Returns context object for formatting.
 */

import fs from "fs";
import { execSync } from "child_process";
import { readConfig, resolveScope } from "./config.mjs";
import { SOCKET_PATH, PID_PATH, MAP_DIR, SIDECAR_LOG_PATH, pluginDir, ensureSwarmDir } from "./paths.mjs";
import { killSidecar, startSidecar } from "./sidecar-client.mjs";
import { checkSessionlogStatus, syncSessionlog } from "./sessionlog.mjs";
import { resolveSwarmkit, configureNodePath } from "./swarmkit-resolver.mjs";

/**
 * Install plugin-local dependencies if not already present.
 * Installs js-yaml and swarmkit (bundled). Still needed for
 * the plugin's own code dependencies.
 */
function installLocalDeps(dir) {
  const nodeModules = `${dir}/node_modules`;
  if (fs.existsSync(nodeModules)) return;

  process.stderr.write("Installing claude-code-swarm dependencies...\n");
  try {
    execSync("npm install --production", {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    process.stderr.write(`Warning: npm install failed: ${err.message}\n`);
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
    process.stderr.write("[bootstrap] swarmkit not available, skipping global package check\n");
    return;
  }

  const required = getRequiredGlobalPackages(config);
  const missing = [];

  for (const pkg of required) {
    try {
      const version = await swarmkit.getInstalledVersion(pkg);
      if (!version) {
        missing.push(pkg);
      }
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length === 0) return;

  process.stderr.write(`[bootstrap] Installing missing packages: ${missing.join(", ")}...\n`);
  try {
    const results = await swarmkit.installPackages(missing);
    for (const r of results) {
      if (r.success) {
        process.stderr.write(`[bootstrap] Installed ${r.package}@${r.version}\n`);
      } else {
        process.stderr.write(`[bootstrap] Warning: failed to install ${r.package}: ${r.error}\n`);
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
    process.stderr.write(`[bootstrap] Warning: global package install failed: ${err.message}\n`);
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
 * Start the MAP sidecar in session mode.
 * Kills any existing sidecar first, then starts a new one.
 * Returns status string.
 */
async function startSessionSidecar(config, scope, dir) {
  // Kill any existing sidecar from a previous session
  killSidecar();

  const ok = await startSidecar(config, dir);
  if (ok) {
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
 * Full bootstrap flow. Returns context object for formatting.
 */
export async function bootstrap(pluginDirOverride) {
  const dir = pluginDirOverride || pluginDir();

  // 0. Install local dependencies (js-yaml, swarmkit)
  installLocalDeps(dir);

  // 1. Read config (before ensureGlobalPackages so we know what's needed)
  const config = readConfig();

  // 1b. Configure NODE_PATH (global + local node_modules)
  configureNodePath(dir);

  // 1c. Ensure global packages are installed via swarmkit (async, best-effort)
  await ensureGlobalPackages(config);

  // 1d. Initialize swarmkit project directories (.swarm/openteams/, .swarm/sessionlog/, .swarm/claude-swarm/)
  await initSwarmProject(config);

  const scope = resolveScope(config);

  // 2. Check sessionlog status
  let sessionlogStatus = "not installed";
  if (config.sessionlog.enabled) {
    sessionlogStatus = checkSessionlogStatus();
  }

  // 3. Start MAP sidecar if configured
  let mapStatus = "disabled";
  if (config.map.enabled) {
    fs.mkdirSync(MAP_DIR, { recursive: true });

    if (config.map.sidecar === "session") {
      mapStatus = await startSessionSidecar(config, scope, dir);
    } else if (config.map.sidecar === "persistent") {
      mapStatus = checkPersistentSidecar(scope);
    }
  }

  // 3b. Initial sessionlog sync (fire and forget)
  if (config.map.enabled && config.sessionlog.sync !== "off") {
    syncSessionlog(config).catch(() => {});
  }

  return {
    template: config.template,
    mapEnabled: config.map.enabled,
    mapStatus,
    sessionlogEnabled: config.sessionlog.enabled,
    sessionlogStatus,
    sessionlogSync: config.sessionlog.sync,
  };
}
