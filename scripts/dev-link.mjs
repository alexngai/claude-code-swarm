#!/usr/bin/env node
/**
 * dev-link.mjs — Link/unlink local plugin for development
 *
 * Two-pronged approach to survive Claude Code plugin updates:
 * 1. Updates installPath in installed_plugins.json to point to the local repo
 *    (so CLAUDE_PLUGIN_ROOT resolves directly — survives cache dir overwrites)
 * 2. Replaces the cache directory with a symlink as a fallback
 *
 * Usage:
 *   npm run dev:link      — replace cache dir with symlink to local repo
 *   npm run dev:unlink    — remove symlink, reinstall from marketplace
 *   npm run dev:status    — check current link state
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), "..");
const PLUGIN_KEY = "claude-code-swarm@claude-code-swarm";
const MARKETPLACE_KEY = "claude-code-swarm";
const PLUGINS_DIR = path.join(os.homedir(), ".claude", "plugins");
const CACHE_DIR = path.join(PLUGINS_DIR, "cache");
const INSTALLED_PLUGINS_PATH = path.join(PLUGINS_DIR, "installed_plugins.json");
const MARKETPLACES_PATH = path.join(PLUGINS_DIR, "known_marketplaces.json");

const action = process.argv[2];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.error(`Could not read ${filePath}`);
    process.exit(1);
  }
}

function getPluginEntry() {
  const data = readJson(INSTALLED_PLUGINS_PATH);
  const entries = data.plugins?.[PLUGIN_KEY];
  if (!entries?.length) {
    console.error(`Plugin "${PLUGIN_KEY}" not found in installed_plugins.json`);
    process.exit(1);
  }
  return { data, entry: entries[0] };
}

function getMarketplacePath() {
  const data = readJson(MARKETPLACES_PATH);
  const marketplace = data[MARKETPLACE_KEY];
  if (!marketplace?.installLocation) {
    console.error(`Marketplace "${MARKETPLACE_KEY}" not found in known_marketplaces.json`);
    process.exit(1);
  }
  return marketplace.installLocation;
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Get the cache path that Claude Code actually uses for CLAUDE_PLUGIN_ROOT.
 * This is the installPath from installed_plugins.json (usually under ~/.claude/plugins/cache/).
 */
function getCachePath() {
  const { entry } = getPluginEntry();
  // If installPath was already changed to local repo, look for the original
  if (entry.installPath === PLUGIN_ROOT && entry._originalInstallPath) {
    return entry._originalInstallPath;
  }
  return entry.installPath;
}

function link() {
  const cachePath = getCachePath();
  const { data, entry } = getPluginEntry();

  // 1. Update installPath in installed_plugins.json to point to local repo
  if (entry.installPath !== PLUGIN_ROOT) {
    entry._originalInstallPath = entry.installPath;
    entry.installPath = PLUGIN_ROOT;
    fs.writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log(`Updated installPath: ${entry._originalInstallPath} → ${PLUGIN_ROOT}`);
  } else {
    console.log(`installPath already points to local repo`);
  }

  // 2. Create symlink at cache path as fallback (in case Claude Code still resolves from cache)
  if (isSymlink(cachePath)) {
    const target = fs.readlinkSync(cachePath);
    if (target === PLUGIN_ROOT) {
      console.log(`Symlink already exists: ${cachePath} → ${PLUGIN_ROOT}`);
    } else {
      console.error(`Cache path symlinked to a different target: ${target}`);
      process.exit(1);
    }
  } else {
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true, force: true });
      console.log(`Removed cached copy: ${cachePath}`);
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.symlinkSync(PLUGIN_ROOT, cachePath, "dir");
    console.log(`Symlinked: ${cachePath} → ${PLUGIN_ROOT}`);
  }

  console.log("\nRestart Claude Code for changes to take effect.");
}

function unlink() {
  const { data, entry } = getPluginEntry();
  const cachePath = entry._originalInstallPath || entry.installPath;

  // 1. Restore installPath in installed_plugins.json
  if (entry._originalInstallPath) {
    entry.installPath = entry._originalInstallPath;
    delete entry._originalInstallPath;
    fs.writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log(`Restored installPath: ${entry.installPath}`);
  }

  // 2. Remove symlink if present
  if (isSymlink(cachePath)) {
    fs.unlinkSync(cachePath);
    console.log(`Removed symlink: ${cachePath}`);
  } else if (entry.installPath === PLUGIN_ROOT) {
    // installPath still points to local repo but no symlink — just restore path
    console.log(`No symlink to remove at ${cachePath}`);
  } else if (fs.existsSync(cachePath)) {
    console.log(`Not linked (${cachePath} is not a symlink)`);
    return;
  }

  // 3. Reinstall from marketplace clone
  const marketplacePath = getMarketplacePath();
  const pluginDir = path.join(marketplacePath, ".claude-plugin");

  if (!fs.existsSync(pluginDir)) {
    console.error(`Marketplace clone missing .claude-plugin/ at ${marketplacePath}`);
    console.error("Run 'claude plugins update' to reinstall.");
    process.exit(1);
  }

  fs.cpSync(marketplacePath, cachePath, { recursive: true });

  try {
    execSync("npm install --production --ignore-scripts", {
      cwd: cachePath,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    console.warn("Warning: npm install failed, plugin may not work correctly");
  }

  const pkgJson = readJson(path.join(cachePath, "package.json"));
  console.log(`Unlinked: reinstalled from marketplace at ${cachePath} (v${pkgJson.version})`);
  console.log("\nRestart Claude Code for changes to take effect.");
}

function status() {
  const { entry } = getPluginEntry();
  const cachePath = entry._originalInstallPath || entry.installPath;
  const installPathLinked = entry.installPath === PLUGIN_ROOT;
  const symlinkLinked = isSymlink(cachePath);

  console.log(`installPath: ${entry.installPath}${installPathLinked ? " (dev-linked)" : ""}`);
  if (entry._originalInstallPath) {
    console.log(`  original: ${entry._originalInstallPath}`);
  }

  if (symlinkLinked) {
    const target = fs.readlinkSync(cachePath);
    console.log(`symlink: ${cachePath} → ${target}`);
  } else if (fs.existsSync(cachePath)) {
    const pkgPath = path.join(cachePath, "package.json");
    const version = fs.existsSync(pkgPath) ? readJson(pkgPath).version : "?";
    console.log(`cache: ${cachePath} (v${version}, not symlinked)`);
  } else {
    console.log(`cache: ${cachePath} (missing)`);
  }

  if (installPathLinked && symlinkLinked) {
    console.log("\nStatus: FULLY LINKED (installPath + symlink)");
  } else if (installPathLinked) {
    console.log("\nStatus: LINKED via installPath (symlink missing — may still work)");
  } else if (symlinkLinked) {
    console.log("\nStatus: LINKED via symlink only (installPath not updated)");
  } else {
    console.log("\nStatus: NOT LINKED");
  }
}

switch (action) {
  case "link":
    link();
    break;
  case "unlink":
    unlink();
    break;
  case "status":
    status();
    break;
  default:
    console.error("Usage: dev-link.mjs <link|unlink|status>");
    process.exit(1);
}
