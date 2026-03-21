#!/usr/bin/env node
/**
 * bootstrap.mjs — SessionStart hook entry point
 *
 * Two-phase design for fast startup:
 * 1. Fast path: reads config + cached team → writes context to stdout immediately
 * 2. Background: spawns a detached child process for slow operations
 *    (package checks, sidecar startup, project init)
 *
 * Output goes to stdout → injected into Claude's context.
 * Exit 0 always — never block the session.
 */

import { bootstrap } from "../src/bootstrap.mjs";
import { formatBootstrapContext } from "../src/context-output.mjs";
import { createLogger } from "../src/log.mjs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const log = createLogger("bootstrap");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Stdin reader ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    if (process.stdin.readableEnded) resolve({});
    setTimeout(() => resolve({}), 200);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const hookData = await readStdin();
  const sessionId = hookData.session_id || null;

  // Fast path: returns immediately with cached team + config
  const result = await bootstrap(undefined, sessionId);
  const output = formatBootstrapContext({
    template: result.template,
    team: result.team,
    mapEnabled: result.mapEnabled,
    mapStatus: result.mapEnabled ? result.mapStatus : null,
    sessionlogStatus: result.sessionlogEnabled ? result.sessionlogStatus : null,
    sessionlogSync: result.sessionlogSync,
    opentasksEnabled: result.opentasksEnabled,
    opentasksStatus: result.opentasksStatus,
    inboxEnabled: result.inboxEnabled,
    meshEnabled: result.meshEnabled,
    minimemEnabled: result.minimemEnabled,
    minimemStatus: result.minimemStatus,
    skilltreeEnabled: result.skilltreeEnabled,
    skilltreeStatus: result.skilltreeStatus,
  });
  process.stdout.write(output);

  // Background path: spawn detached child for slow operations
  // (package version checks, sidecar startup, project init)
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "bootstrap-bg.mjs"), JSON.stringify({ sessionId })],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH || "" },
    }
  );
  child.unref();
} catch (err) {
  log.error("bootstrap failed", { error: err.message });
  // Still output something useful
  process.stdout.write("## Claude Code Swarm\n\nUse `/swarm` to launch a team.\n");
}
