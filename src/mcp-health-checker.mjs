/**
 * mcp-health-checker.mjs — compare declared MCP providers against the
 * set of servers known to be installed, produce a report, and format it
 * for human consumption.
 *
 * Two entry points:
 *   checkMcpHealth({ providers, activeSet, scopeReferences }) — pure
 *   discoverActiveSet({ projectPath, pluginPath, userPath }) — reads fs
 *
 * See docs/loadout-consumer-design.md for the non-invasive design.
 */

import fs from "fs";
import path from "path";
import os from "os";

/**
 * Compare declared providers against the active set and return a report.
 * Pure function — no I/O. Consumers supply the active-set via discoverActiveSet
 * or their own logic (e.g. hive DB lookup).
 *
 * @param providers         Map<string, McpProviderSpec> or plain object from team.yaml
 * @param activeSet         Map<string, { source, spec? }> of installed servers
 * @param scopeReferences   [{ loadout, server }] — which loadouts reference which servers
 * @returns {MCPHealthReport}
 */
export function checkMcpHealth({
  providers,
  activeSet = new Map(),
  scopeReferences = [],
} = {}) {
  const providerMap = toMap(providers);
  const activeMap = toMap(activeSet);

  const ok = [];
  const missing = [];
  const disabled = [];
  const refs = [];

  for (const [name, spec] of providerMap) {
    if (spec?.disabled) {
      disabled.push({ name, spec });
      continue;
    }
    if (spec?.ref) {
      refs.push({ name, ref: spec.ref, spec });
      continue;
    }
    const active = activeMap.get(name);
    if (active) {
      ok.push({ name, source: active.source, spec });
    } else {
      missing.push({ name, spec });
    }
  }

  // Active servers that are NOT declared in providers — informational only.
  // Useful for detecting plugin MCPs or user-installed servers the team
  // template wasn't aware of but can still reference in scope.
  const activeOnly = [];
  for (const [name, active] of activeMap) {
    if (!providerMap.has(name)) {
      activeOnly.push({ name, source: active.source });
    }
  }

  // Scope references that aren't backed by providers OR active servers.
  // These are the "loadout X wants server Y but it's not available" cases.
  const orphanedReferences = [];
  const availableSet = new Set([...providerMap.keys(), ...activeMap.keys()]);
  for (const ref of scopeReferences) {
    if (!ref?.server) continue;
    if (!availableSet.has(ref.server)) {
      orphanedReferences.push({ loadout: ref.loadout, server: ref.server });
    }
  }

  return {
    ok,
    missing,
    disabled,
    refs,
    activeOnly,
    orphanedReferences,
  };
}

/**
 * Collect the set of MCP servers known to be installed by reading the
 * well-known Claude Code configuration paths.
 *
 * Priority order (later wins on conflict):
 *   1. Plugin MCPs (.claude-plugin/plugin.json:mcpServers)
 *   2. User MCPs (~/.claude/mcp.json:mcpServers or ~/.claude.json:mcpServers)
 *   3. Project MCPs (.mcp.json:mcpServers)
 *
 * Returns a Map<string, { source, spec }> describing which server came
 * from where. Silently skips files that don't exist or fail to parse —
 * this is read-only observation, not config validation.
 */
export function discoverActiveSet({
  projectPath = process.cwd(),
  pluginPath,
  userHome = os.homedir(),
} = {}) {
  const active = new Map();

  // 1. Plugin MCPs — lowest priority
  if (pluginPath) {
    const pluginManifest = path.join(pluginPath, ".claude-plugin", "plugin.json");
    mergeMcpServers(active, pluginManifest, "plugin");
  }

  // 2. User MCPs — middle priority
  const userMcp = path.join(userHome, ".claude", "mcp.json");
  mergeMcpServers(active, userMcp, "user");

  // 3. Project MCPs — highest priority
  const projectMcp = path.join(projectPath, ".mcp.json");
  mergeMcpServers(active, projectMcp, "project");

  return active;
}

/**
 * Scan a loadouts map for every scope reference — useful input for
 * checkMcpHealth's scopeReferences arg. Accepts either openteams' native
 * Map<name, ResolvedLoadout> or a plain object of the same shape.
 */
export function collectScopeReferences(loadouts) {
  const out = [];
  const it = toMap(loadouts);
  for (const [name, lo] of it) {
    const scope = lo?.mcpScope ?? [];
    for (const entry of scope) {
      if (entry?.server) {
        out.push({ loadout: name, server: entry.server });
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Formatting — human-readable report
// ────────────────────────────────────────────────────────────────

const STATUS = {
  ok: "✓",
  missing: "⚠",
  refs: "◎",
  disabled: "○",
};

/**
 * Render a report as a text block suitable for terminal output.
 * ASCII-only — no terminal-color escapes (callers can colorize).
 */
export function formatHealthReport(report, { teamName = "team" } = {}) {
  const lines = [];
  lines.push(`Team "${teamName}" MCP status`);
  lines.push("─".repeat(40));

  if (
    report.ok.length === 0 &&
    report.missing.length === 0 &&
    report.refs.length === 0 &&
    report.disabled.length === 0
  ) {
    lines.push("(no MCP providers declared; team may use installed servers)");
  }

  for (const e of report.ok) {
    lines.push(`  ${STATUS.ok} ${e.name}  (${e.source})`);
  }
  for (const e of report.missing) {
    lines.push(`  ${STATUS.missing} ${e.name}  (declared, not active)`);
    lines.push(`      → /swarm mcp install ${e.name}`);
  }
  for (const e of report.refs) {
    lines.push(`  ${STATUS.refs} ${e.name}  (ref: ${e.ref})`);
    lines.push(`      → ref resolution deferred`);
  }
  for (const e of report.disabled) {
    lines.push(`  ${STATUS.disabled} ${e.name}  (disabled)`);
  }

  if (report.orphanedReferences.length > 0) {
    lines.push("");
    lines.push("Loadout scope references not backed by any provider:");
    for (const r of report.orphanedReferences) {
      lines.push(`  - loadout "${r.loadout}" uses "${r.server}"`);
    }
  }

  if (report.activeOnly.length > 0) {
    lines.push("");
    lines.push(`Active servers not declared: ${report.activeOnly.map((a) => a.name).join(", ")}`);
  }

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────

function toMap(input) {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  return new Map(Object.entries(input));
}

function mergeMcpServers(active, jsonPath, source) {
  if (!fs.existsSync(jsonPath)) return;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch {
    return;
  }
  const mcp = doc?.mcpServers;
  if (!mcp || typeof mcp !== "object") return;
  for (const [name, spec] of Object.entries(mcp)) {
    active.set(name, { source, spec });
  }
}

/**
 * @typedef {Object} MCPHealthReport
 * @property {Array<{name: string, source: string, spec: object}>} ok
 * @property {Array<{name: string, spec: object}>} missing
 * @property {Array<{name: string, spec: object}>} disabled
 * @property {Array<{name: string, ref: string, spec: object}>} refs
 * @property {Array<{name: string, source: string}>} activeOnly
 * @property {Array<{loadout: string, server: string}>} orphanedReferences
 */
