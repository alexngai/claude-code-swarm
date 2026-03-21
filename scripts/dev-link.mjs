#!/usr/bin/env node
/**
 * dev-link.mjs — Link/unlink local plugin for development
 *
 * Replaces the installed plugin cache entry with a symlink to the local repo,
 * so Claude Code uses your working copy directly. Restart Claude Code after
 * linking/unlinking for changes to take effect.
 *
 * Usage:
 *   npm run dev:link      — remove cached copy, symlink local repo
 *   npm run dev:unlink    — remove symlink, reinstall latest from marketplace
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

function link() {
  const { entry } = getPluginEntry();
  const installPath = entry.installPath;

  if (isSymlink(installPath)) {
    const target = fs.readlinkSync(installPath);
    if (target === PLUGIN_ROOT) {
      console.log(`Already linked: ${installPath} → ${PLUGIN_ROOT}`);
      return;
    }
    console.error(`Already symlinked to a different target: ${target}`);
    process.exit(1);
  }

  // Remove the cached copy
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true });
    console.log(`Removed cached copy: ${installPath}`);
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(installPath), { recursive: true });

  // Create symlink
  fs.symlinkSync(PLUGIN_ROOT, installPath, "dir");
  console.log(`Linked: ${installPath} → ${PLUGIN_ROOT}`);
  console.log("\nRestart Claude Code for changes to take effect.");
}

function unlink() {
  const { data, entry } = getPluginEntry();
  const installPath = entry.installPath;

  if (!isSymlink(installPath)) {
    console.log(`Not linked (${installPath} is not a symlink)`);
    return;
  }

  // Remove symlink
  fs.unlinkSync(installPath);
  console.log(`Removed symlink: ${installPath}`);

  // Reinstall from marketplace clone
  const marketplacePath = getMarketplacePath();
  const pluginDir = path.join(marketplacePath, ".claude-plugin");

  if (!fs.existsSync(pluginDir)) {
    console.error(`Marketplace clone missing .claude-plugin/ at ${marketplacePath}`);
    console.error("Run 'claude plugins update' to reinstall.");
    process.exit(1);
  }

  // Read the version from marketplace clone
  const pkgJson = readJson(path.join(marketplacePath, "package.json"));
  const version = pkgJson.version || "latest";

  // Copy marketplace clone to cache (same as what Claude Code does on install)
  const versionDir = path.join(path.dirname(installPath), version);
  fs.cpSync(marketplacePath, versionDir, { recursive: true });

  // Install production deps
  try {
    execSync("npm install --production --ignore-scripts", {
      cwd: versionDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    console.warn("Warning: npm install failed, plugin may not work correctly");
  }

  // Update installed_plugins.json with new version/path
  data.plugins[PLUGIN_KEY][0] = {
    ...entry,
    installPath: versionDir,
    version,
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(INSTALLED_PLUGINS_PATH, JSON.stringify(data, null, 2));

  console.log(`Reinstalled from marketplace: ${versionDir} (v${version})`);
  console.log("\nRestart Claude Code for changes to take effect.");
}

function status() {
  const { entry } = getPluginEntry();
  const installPath = entry.installPath;

  if (isSymlink(installPath)) {
    const target = fs.readlinkSync(installPath);
    console.log(`LINKED: ${installPath} → ${target}`);
  } else if (fs.existsSync(installPath)) {
    console.log(`NOT LINKED: using cached copy at ${installPath} (v${entry.version})`);
  } else {
    console.log(`MISSING: ${installPath} does not exist`);
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
