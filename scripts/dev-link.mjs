#!/usr/bin/env node
/**
 * dev-link.mjs — Link/unlink local plugin for development
 *
 * Replaces the installed plugin cache directory with a symlink to the local
 * repo. Claude Code resolves CLAUDE_PLUGIN_ROOT from the original cache path,
 * so we must symlink there (editing installed_plugins.json alone doesn't work).
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

  if (isSymlink(cachePath)) {
    const target = fs.readlinkSync(cachePath);
    if (target === PLUGIN_ROOT) {
      console.log(`Already linked: ${cachePath} → ${PLUGIN_ROOT}`);
      return;
    }
    console.error(`Already symlinked to a different target: ${target}`);
    process.exit(1);
  }

  // Remove the cached copy
  if (fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
    console.log(`Removed cached copy: ${cachePath}`);
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  // Create symlink
  fs.symlinkSync(PLUGIN_ROOT, cachePath, "dir");
  console.log(`Linked: ${cachePath} → ${PLUGIN_ROOT}`);
  console.log("\nRestart Claude Code for changes to take effect.");
}

function unlink() {
  const cachePath = getCachePath();

  if (!isSymlink(cachePath)) {
    console.log(`Not linked (${cachePath} is not a symlink)`);
    return;
  }

  // Remove symlink
  fs.unlinkSync(cachePath);
  console.log(`Removed symlink: ${cachePath}`);

  // Reinstall from marketplace clone
  const marketplacePath = getMarketplacePath();
  const pluginDir = path.join(marketplacePath, ".claude-plugin");

  if (!fs.existsSync(pluginDir)) {
    console.error(`Marketplace clone missing .claude-plugin/ at ${marketplacePath}`);
    console.error("Run 'claude plugins update' to reinstall.");
    process.exit(1);
  }

  // Copy marketplace clone to cache
  fs.cpSync(marketplacePath, cachePath, { recursive: true });

  // Install production deps
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
  const cachePath = getCachePath();

  if (isSymlink(cachePath)) {
    const target = fs.readlinkSync(cachePath);
    console.log(`LINKED: ${cachePath} → ${target}`);
  } else if (fs.existsSync(cachePath)) {
    const pkgPath = path.join(cachePath, "package.json");
    const version = fs.existsSync(pkgPath) ? readJson(pkgPath).version : "?";
    console.log(`NOT LINKED: using cached copy at ${cachePath} (v${version})`);
  } else {
    console.log(`MISSING: ${cachePath} does not exist`);
    console.log(`  Run 'npm run dev:link' to create symlink.`);
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
