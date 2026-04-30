#!/usr/bin/env node
/**
 * scope-check.mjs — Generic PreToolUse hook for enforcing per-role MCP
 * scope declared in a swarm-generated scope file.
 *
 * Invoked per sub-agent via frontmatter:
 *
 *   hooks:
 *     PreToolUse:
 *       - matcher: "mcp__.*"
 *         hooks:
 *           - type: command
 *             command: ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs
 *             env:
 *               SCOPE_FILE: .swarm/.../scope/<role>.json
 *               ROLE_NAME:  <role>
 *
 * Input: tool-call JSON via stdin (Claude Code hook protocol).
 * Output:
 *   exit 0 → allow
 *   exit 2 → block, with human-readable reason printed to stderr
 *
 * See docs/loadout-consumer-design.md for the larger design.
 */

import fs from "fs";

const MCP_PREFIX = "mcp__";

async function main() {
  const input = await readStdin();
  let parsed;
  try {
    parsed = input ? JSON.parse(input) : {};
  } catch {
    // Can't parse input — allow, not our place to block on hook-protocol glitches.
    process.exit(0);
  }

  const toolName = parsed?.tool_name ?? "";
  if (!toolName.startsWith(MCP_PREFIX)) {
    // Shouldn't happen under the mcp__.* matcher, but be defensive.
    process.exit(0);
  }

  const parts = toolName.slice(MCP_PREFIX.length).split("__");
  if (parts.length < 2) {
    // Malformed MCP tool name — allow, nothing to check.
    process.exit(0);
  }
  const server = parts[0];
  const tool = parts.slice(1).join("__");

  const scopeFilePath = process.env.SCOPE_FILE;
  if (!scopeFilePath) {
    // No scope file configured — nothing to enforce, allow.
    process.exit(0);
  }

  let scopeDoc;
  try {
    scopeDoc = JSON.parse(fs.readFileSync(scopeFilePath, "utf-8"));
  } catch (err) {
    writeError(
      `scope-check: could not read scope file at ${scopeFilePath} ` +
        `(${err.message}). Allowing tool call — install claude-code-swarm ` +
        `correctly or remove the hook to silence this.`
    );
    process.exit(0);
  }

  const scopeList = Array.isArray(scopeDoc?.scope) ? scopeDoc.scope : [];
  const entry = scopeList.find((s) => s?.server === server);

  // If the server is referenced in scope but restricted → enforce.
  // If the server is not in scope at all, Claude Code's own `mcpServers:`
  // allowlist should have blocked this already; we don't second-guess it.
  if (!entry) {
    process.exit(0);
  }

  const role = process.env.ROLE_NAME || scopeDoc?.role || "(unknown)";

  if (Array.isArray(entry.exclude) && entry.exclude.includes(tool)) {
    writeError(
      `Tool ${toolName} is denied for role "${role}" (listed in scope exclude).`
    );
    process.exit(2);
  }

  if (Array.isArray(entry.tools) && entry.tools.length > 0) {
    if (!entry.tools.includes(tool)) {
      writeError(
        `Tool ${toolName} is not in the scope allowlist for role "${role}" ` +
          `(allowed: ${entry.tools.join(", ")}).`
      );
      process.exit(2);
    }
  }

  // No restriction hit — allow.
  process.exit(0);
}

function writeError(msg) {
  process.stderr.write(msg + "\n");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    // If stdin is a TTY we're running interactively — no input to consume.
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  // On any unexpected error, fail open (allow) with a message.
  // Hook errors should not break the agent — blocking a valid tool
  // call because our hook crashed is worse than allowing an out-of-scope one.
  writeError(`scope-check: unexpected error — ${err?.message ?? err}`);
  process.exit(0);
});
