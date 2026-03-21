#!/usr/bin/env node
/**
 * bootstrap-bg.mjs — Background bootstrap worker
 *
 * Spawned as a detached child by bootstrap.mjs after the fast path completes.
 * Handles slow operations: package version checks, sidecar startup, project init.
 * Errors go to stderr (logged but don't affect the session).
 */

import { readConfig, resolveScope } from "../src/config.mjs";
import { pluginDir } from "../src/paths.mjs";
import { configureNodePath } from "../src/swarmkit-resolver.mjs";
import { backgroundInit } from "../src/bootstrap.mjs";
import { createLogger, init as initLog } from "../src/log.mjs";

const log = createLogger("bootstrap:bg");

try {
  const args = JSON.parse(process.argv[2] || "{}");
  const sessionId = args.sessionId || null;
  const dir = pluginDir();

  const config = readConfig();
  initLog({ ...config.log, sessionId });
  configureNodePath(dir);
  const scope = resolveScope(config);

  await backgroundInit(config, scope, dir, sessionId);
} catch (err) {
  log.error("background init failed", { error: err.message });
}
