/**
 * swarmkit-resolver.mjs — Resolve swarmkit and manage NODE_PATH for global packages
 *
 * Resolution order for swarmkit:
 * 1. Global swarmkit (via npm prefix -g / node_modules / swarmkit)
 * 2. Bundled swarmkit (this plugin's node_modules/swarmkit)
 *
 * Also provides NODE_PATH configuration so that globally-installed packages
 * (openteams, @multi-agent-protocol/sdk, sessionlog) are resolvable via
 * dynamic import() throughout the codebase.
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { pluginDir } from "./paths.mjs";

let _globalPrefix = undefined;
let _swarmkit = undefined;

/**
 * Get the global npm prefix path (cached in-memory + on disk).
 * The disk cache avoids a ~70ms execSync('npm prefix -g') on every startup.
 * Returns null if npm is not available.
 */
export function getGlobalPrefix() {
  if (_globalPrefix !== undefined) return _globalPrefix;

  // Try disk cache first (stable across sessions — only changes if npm is reinstalled)
  const cacheFile = path.join(pluginDir(), "node_modules", ".npm-prefix-cache");
  try {
    const cached = fs.readFileSync(cacheFile, "utf-8").trim();
    if (cached && fs.existsSync(cached)) {
      _globalPrefix = cached;
      return _globalPrefix;
    }
  } catch {
    // Cache miss — fall through
  }

  try {
    _globalPrefix = execSync("npm prefix -g", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Persist to disk cache (best-effort)
    try { fs.writeFileSync(cacheFile, _globalPrefix); } catch {}
  } catch {
    _globalPrefix = null;
  }
  return _globalPrefix;
}

/**
 * Get the global node_modules path.
 * On Unix: <prefix>/lib/node_modules
 */
export function getGlobalNodeModules() {
  const prefix = getGlobalPrefix();
  if (!prefix) return null;
  const libPath = path.join(prefix, "lib", "node_modules");
  if (fs.existsSync(libPath)) return libPath;
  // Fallback: directly under prefix (some npm configurations)
  const directPath = path.join(prefix, "node_modules");
  if (fs.existsSync(directPath)) return directPath;
  return null;
}

/**
 * Set NODE_PATH to include global node_modules + plugin local node_modules.
 * Called once during bootstrap so dynamic imports resolve correctly.
 */
export function configureNodePath(pluginDirOverride) {
  const dir = pluginDirOverride || pluginDir();
  const paths = [];

  // Global node_modules (for openteams, @multi-agent-protocol/sdk, sessionlog)
  const globalNm = getGlobalNodeModules();
  if (globalNm) paths.push(globalNm);

  // Plugin-local node_modules (for js-yaml, swarmkit)
  const localNm = path.join(dir, "node_modules");
  if (fs.existsSync(localNm)) paths.push(localNm);

  // Prepend to existing NODE_PATH, deduplicate
  const existing = process.env.NODE_PATH || "";
  const combined = [...paths, ...existing.split(path.delimiter).filter(Boolean)];
  process.env.NODE_PATH = [...new Set(combined)].join(path.delimiter);
}

/**
 * Resolve swarmkit. Tries global first, then bundled.
 * Returns the swarmkit module or null. Never throws.
 */
export async function resolveSwarmkit() {
  if (_swarmkit !== undefined) return _swarmkit;

  // 1. Try global swarmkit
  const globalNm = getGlobalNodeModules();
  if (globalNm) {
    const globalPath = path.join(globalNm, "swarmkit");
    if (fs.existsSync(globalPath)) {
      try {
        _swarmkit = await import(/* @vite-ignore */ globalPath);
        return _swarmkit;
      } catch {
        // Fall through to bundled
      }
    }
  }

  // 2. Try bundled swarmkit (plugin's node_modules)
  try {
    _swarmkit = await import("swarmkit");
    return _swarmkit;
  } catch {
    _swarmkit = null;
    return null;
  }
}

/**
 * Resolve an optional global package by name.
 * Tries bare import first (works if in local dependencies), then falls back
 * to absolute path via global node_modules (where swarmkit installs packages).
 *
 * ESM dynamic import() doesn't respect runtime NODE_PATH changes, so bare
 * imports fail for packages only installed globally. This helper works around
 * that by using absolute paths as a fallback.
 *
 * Results are cached in-memory. Returns the module or null. Never throws.
 *
 * @param {string} name - Package name (e.g. "agent-inbox", "sessionlog")
 * @returns {Promise<object|null>}
 */
const _packageCache = new Map();

export async function resolvePackage(name) {
  if (_packageCache.has(name)) return _packageCache.get(name);

  // 1. Try bare import (works for local dependencies)
  try {
    const mod = await import(/* @vite-ignore */ name);
    _packageCache.set(name, mod);
    return mod;
  } catch {
    // Not locally resolvable
  }

  // 2. Try global node_modules (where swarmkit installs)
  const globalNm = getGlobalNodeModules();
  if (globalNm) {
    const globalPath = path.join(globalNm, name);
    if (fs.existsSync(globalPath)) {
      try {
        const mod = await import(/* @vite-ignore */ globalPath);
        _packageCache.set(name, mod);
        return mod;
      } catch {
        // Global path exists but import failed
      }
    }
  }

  _packageCache.set(name, null);
  return null;
}

/** Reset cached state (for testing) */
export function _resetCache() {
  _globalPrefix = undefined;
  _swarmkit = undefined;
  _packageCache.clear();
}
