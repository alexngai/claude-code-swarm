/**
 * loadout-materializer.mjs — pure functions that convert openteams
 * loadouts into Claude Code sub-agent frontmatter + sibling scope files.
 *
 * No filesystem writes in this module. All I/O is the caller's job.
 * See docs/loadout-consumer-design.md for the full design.
 *
 * Inputs:
 *   - role        — role object (at minimum: { name, description?, displayName? })
 *   - loadout     — openteams ResolvedLoadout (may be undefined for loadout-less roles)
 *   - template    — openteams ResolvedTemplate shape (mcpProviders as Map or plain object)
 *   - options     — { teamName, projectPath, hookCommand, scopeFilePath, nativeTools, position }
 *
 * Output from materializeLoadout():
 *   {
 *     frontmatter: {...},    // YAML-serializable object for AGENT.md
 *     scopeFile:   {...},    // JSON-serializable object for the scope-check hook
 *     warnings:    [string], // non-fatal issues to surface to the user
 *   }
 */

const MCP_TOOL_PREFIX = "mcp__";

/**
 * Build the full materialization result for a role.
 */
export function materializeLoadout({
  role,
  loadout,
  template,
  options = {},
} = {}) {
  if (!role || typeof role !== "object" || !role.name) {
    throw new Error("materializeLoadout: role.name is required");
  }
  const warnings = [];
  const teamName = options.teamName ?? template?.manifest?.name ?? "team";

  const mcp = resolveMcpScope({
    mcpScope: loadout?.mcpScope ?? [],
    mcpInstalls: loadout?.mcpServers ?? [],
    providers: toProviderMap(template?.mcpProviders),
    warnings,
    roleName: role.name,
  });

  const scopeFile = buildScopeFile({
    role,
    loadout,
    mcp,
    teamName,
  });

  const frontmatter = buildFrontmatter({
    role,
    loadout,
    teamName,
    mcp,
    scopeFilePath: options.scopeFilePath,
    hookCommand: options.hookCommand,
    projectPath: options.projectPath,
    nativeTools: options.nativeTools ?? defaultNativeTools(role, options),
    position: options.position,
  });

  return { frontmatter, scopeFile, warnings };
}

// ────────────────────────────────────────────────────────────────
// MCP scope resolution
// ────────────────────────────────────────────────────────────────

/**
 * Normalize mcpScope (from openteams) + install-bearing mcpServers
 * into the shapes we need:
 *
 *   mcpServers       — list of `string | inline` for frontmatter
 *   disallowedTools  — list of `mcp__<server>__<tool>` for frontmatter
 *   scope            — canonical scope list for the scope file
 *                      (normalized server → tools?/exclude?)
 *   refs             — symbolic refs the consumer should resolve later
 */
export function resolveMcpScope({
  mcpScope = [],
  mcpInstalls = [],
  providers = new Map(),
  warnings = [],
  roleName = "",
} = {}) {
  const mcpServers = [];
  const seenServers = new Set();
  const refs = [];

  // Install-bearing entries authored by the loadout itself.
  // Inline install specs spawn a subprocess per agent invocation —
  // we emit them verbatim but warn users about the cost.
  for (const install of mcpInstalls) {
    if (install && typeof install === "object" && "ref" in install) {
      refs.push({ ref: install.ref, config: install.config });
      // Refs resolve lazily — don't add to mcpServers until resolved.
      continue;
    }
    if (install && typeof install === "object" && "name" in install) {
      if (seenServers.has(install.name)) continue;
      seenServers.add(install.name);
      const inline = { [install.name]: toInlineSpec(install) };
      mcpServers.push(inline);
      warnings.push(
        `Role "${roleName}": loadout inlines MCP server "${install.name}" — ` +
          `each subagent spawn starts its own subprocess. Consider moving to ` +
          `team.mcp_providers instead.`
      );
    }
  }

  // Pure-scope references. A string-ref entry gives the agent access to
  // the named server from the session-level base set.
  for (const entry of mcpScope) {
    if (!entry || !entry.server) continue;
    const name = entry.server;
    if (!seenServers.has(name)) {
      seenServers.add(name);
      mcpServers.push(name);
    }
    // Advisory: flag if neither providers declare it nor it's inline.
    if (!providers.has(name)) {
      // We don't definitively know whether the consumer has this server
      // installed externally — that's handled by the health-check step.
      // We only warn when providers expressly omit it; the caller can
      // downgrade or clear the warning after checking against the active set.
      // For now, don't push — health-checker owns cross-referencing.
    }
  }

  // Translate exclude lists into literal `mcp__<server>__<tool>` denies.
  const disallowedTools = [];
  for (const entry of mcpScope) {
    if (!entry?.exclude?.length) continue;
    for (const tool of entry.exclude) {
      disallowedTools.push(`${MCP_TOOL_PREFIX}${entry.server}__${tool}`);
    }
  }

  // Build the canonical scope list for the scope file (hook input).
  const scope = mcpScope.map((entry) => {
    const out = { server: entry.server };
    if (entry.tools?.length) out.tools = [...entry.tools];
    if (entry.exclude?.length) out.exclude = [...entry.exclude];
    return out;
  });

  return { mcpServers, disallowedTools, scope, refs };
}

function toInlineSpec(install) {
  const spec = {};
  if (install.command) spec.command = install.command;
  if (install.args) spec.args = [...install.args];
  if (install.env) spec.env = { ...install.env };
  if (install.type) spec.type = install.type;
  return spec;
}

/**
 * Accept either a Map (openteams native) or a plain object (cached JSON)
 * and return a Map for consistent lookup.
 */
function toProviderMap(providers) {
  if (!providers) return new Map();
  if (providers instanceof Map) return providers;
  return new Map(Object.entries(providers));
}

// ────────────────────────────────────────────────────────────────
// Scope file (hook input)
// ────────────────────────────────────────────────────────────────

/**
 * Build the JSON payload the scope-check hook reads at runtime.
 * Includes scope declarations + loadout permissions for enforcement.
 */
export function buildScopeFile({ role, loadout, mcp, teamName }) {
  const scopeFile = {
    role: role.name,
    team: teamName,
    scope: mcp?.scope ?? [],
    permissions: {
      allow: loadout?.permissions?.allow ? [...loadout.permissions.allow] : [],
      deny: loadout?.permissions?.deny ? [...loadout.permissions.deny] : [],
      ask: loadout?.permissions?.ask ? [...loadout.permissions.ask] : [],
    },
  };
  return scopeFile;
}

// ────────────────────────────────────────────────────────────────
// Frontmatter assembly
// ────────────────────────────────────────────────────────────────

/**
 * Assemble the frontmatter object for the AGENT.md file.
 * Order of keys is deliberate for human readability when serialized.
 */
export function buildFrontmatter({
  role,
  loadout,
  teamName,
  mcp,
  scopeFilePath,
  hookCommand,
  projectPath,
  nativeTools,
  position,
}) {
  const name = `${teamName}-${role.name}`;
  const description =
    role.description ||
    loadout?.description ||
    `${role.name} role for the ${teamName} team`;

  const fm = {
    name,
    description,
    team_name: teamName,
    role: role.name,
    generated_by: "claude-code-swarm",
    generated_at: new Date().toISOString(),
  };
  if (projectPath) fm.project_path = projectPath;
  if (position) fm.position = position;

  if (nativeTools?.length) fm.tools = [...nativeTools];

  if (mcp?.mcpServers?.length) fm.mcpServers = mcp.mcpServers;

  if (mcp?.disallowedTools?.length) {
    fm.disallowedTools = mcp.disallowedTools;
  }

  const needsHook = scopeNeedsHook(mcp, loadout);
  if (needsHook && hookCommand && scopeFilePath) {
    fm.hooks = buildHookDeclaration({
      hookCommand,
      scopeFilePath,
      roleName: role.name,
    });
  }

  if (loadout?.capabilities?.length) {
    fm.capabilities = [...loadout.capabilities];
  }

  return fm;
}

/**
 * We only emit a hook when there's something the hook can enforce that
 * the static frontmatter can't — namely tool-level allowlists (no
 * wildcard support in `tools:`) or non-empty permissions lists that
 * aren't already materialized elsewhere.
 */
export function scopeNeedsHook(mcp, loadout) {
  if (!mcp && !loadout) return false;
  if (mcp?.scope?.some((s) => s.tools?.length)) return true;
  if (
    (loadout?.permissions?.allow?.length ?? 0) > 0 ||
    (loadout?.permissions?.deny?.length ?? 0) > 0 ||
    (loadout?.permissions?.ask?.length ?? 0) > 0
  ) {
    return true;
  }
  return false;
}

function buildHookDeclaration({ hookCommand, scopeFilePath, roleName }) {
  return {
    PreToolUse: [
      {
        matcher: `${MCP_TOOL_PREFIX}.*`,
        hooks: [
          {
            type: "command",
            command: hookCommand,
            env: {
              SCOPE_FILE: scopeFilePath,
              ROLE_NAME: roleName,
            },
          },
        ],
      },
    ],
  };
}

// ────────────────────────────────────────────────────────────────
// Native tools defaulting
// ────────────────────────────────────────────────────────────────

/**
 * Mirror the existing agent-generator.mjs behavior for default tools.
 * Callers can override via options.nativeTools if they've already
 * computed tools through another code path.
 */
function defaultNativeTools(role, options = {}) {
  const tools = ["Read", "Glob", "Grep", "Bash"];
  if (options.opentasksEnabled) {
    tools.push("SendMessage");
  } else {
    tools.push("TaskList", "TaskUpdate", "SendMessage");
    if (options.position === "root" || options.position === "companion") {
      tools.push("TaskCreate");
    }
  }
  return tools;
}
