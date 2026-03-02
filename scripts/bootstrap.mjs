#!/usr/bin/env node
/**
 * bootstrap.mjs — SessionStart hook entry point
 *
 * Thin wrapper: delegates to src/bootstrap.mjs + src/context-output.mjs.
 * Output goes to stdout → injected into Claude's context.
 * Exit 0 always — never block the session.
 */

import { bootstrap } from "../src/bootstrap.mjs";
import { formatBootstrapContext } from "../src/context-output.mjs";

try {
  const result = await bootstrap();
  const output = formatBootstrapContext({
    template: result.template,
    mapStatus: result.mapEnabled ? result.mapStatus : null,
    sessionlogStatus: result.sessionlogEnabled ? result.sessionlogStatus : null,
    sessionlogSync: result.sessionlogSync,
  });
  process.stdout.write(output);
} catch (err) {
  process.stderr.write(`[bootstrap] Error: ${err.message}\n`);
  // Still output something useful
  process.stdout.write("## Claude Code Swarm\n\nUse `/swarm` to launch a team.\n");
}
