/**
 * workspace.mjs — Temp workspace setup for e2e tests
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

/**
 * Create an isolated temp workspace for an e2e test.
 * Returns { dir, cleanup }.
 */
export function createWorkspace(options = {}) {
  const {
    prefix = "swarm-e2e-",
    config = undefined,
    gitInit = true,
    files = {},
    tmpdir = os.tmpdir(),
  } = options;

  const dir = fs.mkdtempSync(path.join(tmpdir, prefix));

  if (gitInit) {
    execSync("git init -q", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: dir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  }

  // Write .swarm/claude-swarm/config.json if config provided
  if (config !== undefined) {
    const pluginDir = path.join(dir, ".swarm", "claude-swarm");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "config.json"),
      JSON.stringify(config, null, 2)
    );
  }

  // Write additional files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { dir, cleanup };
}

/**
 * Standard config presets.
 */
export const CONFIGS = {
  minimal: { template: "gsd" },
  withMap: {
    template: "gsd",
    map: { enabled: true, server: "ws://localhost:9876", sidecar: "session" },
  },
  bmadMethod: { template: "bmad-method" },
  noTemplate: {},
};
