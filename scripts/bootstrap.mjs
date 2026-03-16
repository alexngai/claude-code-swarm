#!/usr/bin/env node
/**
 * bootstrap.mjs — SessionStart hook entry point
 *
 * Thin wrapper: delegates to src/bootstrap.mjs + src/context-output.mjs.
 * Reads session_id from stdin (provided by Claude Code hook system).
 * Output goes to stdout → injected into Claude's context.
 * Exit 0 always — never block the session.
 */

import { bootstrap } from "../src/bootstrap.mjs";
import { formatBootstrapContext } from "../src/context-output.mjs";

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
    setTimeout(() => resolve({}), 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const hookData = await readStdin();
  const sessionId = hookData.session_id || null;

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
} catch (err) {
  process.stderr.write(`[bootstrap] Error: ${err.message}\n`);
  // Still output something useful
  process.stdout.write("## Claude Code Swarm\n\nUse `/swarm` to launch a team.\n");
}
