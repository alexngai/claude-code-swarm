/**
 * bootstrap.mjs — SessionStart orchestration for claude-code-swarm
 *
 * Replaces bootstrap.sh: reads config, installs deps, checks integrations,
 * starts MAP sidecar if configured, runs initial sessionlog sync.
 * Returns context object for formatting.
 */

import fs from "fs";
import { execSync } from "child_process";
import { readConfig, resolveScope } from "./config.mjs";
import { SOCKET_PATH, PID_PATH, MAP_DIR, SIDECAR_LOG_PATH, pluginDir } from "./paths.mjs";
import { killSidecar, startSidecar } from "./sidecar-client.mjs";
import { checkSessionlogStatus, syncSessionlog } from "./sessionlog.mjs";

/**
 * Install plugin dependencies if not already present.
 * Runs npm install --production in the plugin directory.
 */
function installDeps(dir) {
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

  // 0. Install dependencies
  installDeps(dir);

  // Set NODE_PATH so plugin-local modules are resolvable
  const nodeModulesPath = `${dir}/node_modules`;
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${nodeModulesPath}:${process.env.NODE_PATH}`
    : nodeModulesPath;

  // 1. Read config
  const config = readConfig();
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
