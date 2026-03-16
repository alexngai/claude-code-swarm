/**
 * context-output.mjs — Markdown formatting for hook stdout
 *
 * Generates the markdown context that gets injected into Claude's conversation
 * by SessionStart and team-loader hooks. Also provides buildCapabilitiesContext()
 * which is shared between SessionStart injection and AGENT.md generation.
 */

import fs from "fs";

// ── Capabilities context (shared between main agent + spawned agents) ────────

/**
 * Build the unified capabilities context markdown.
 *
 * Assembles conditional sections based on which capabilities are enabled.
 * Used by:
 *   - formatBootstrapContext() → injected into main agent via SessionStart stdout
 *   - generateAgentMd() → embedded in each spawned agent's AGENT.md
 *
 * @param {object} options
 * @param {string|null} options.role - null for main agent, role name for spawned agents
 * @param {boolean} options.opentasksEnabled
 * @param {string}  options.opentasksStatus - "connected", "enabled", "disabled", etc.
 * @param {boolean} options.minimemEnabled
 * @param {string}  options.minimemStatus - "ready", "installed", "disabled"
 * @param {boolean} options.skilltreeEnabled
 * @param {string}  options.skilltreeStatus - "ready", "installed", "disabled"
 * @param {boolean} options.inboxEnabled
 * @param {boolean} options.meshEnabled
 * @param {boolean} options.mapEnabled
 * @param {string}  options.mapStatus - "connected (scope: ...)", "disabled", etc.
 * @param {string}  options.sessionlogSync - "off", "lifecycle", "metrics", "full"
 * @param {string}  options.teamName - team name for spawned agent context
 * @returns {string} Markdown capabilities context
 */
export function buildCapabilitiesContext({
  role = null,
  opentasksEnabled = false,
  opentasksStatus = "disabled",
  minimemEnabled = false,
  minimemStatus = "disabled",
  skilltreeEnabled = false,
  skilltreeStatus = "disabled",
  inboxEnabled = false,
  meshEnabled = false,
  mapEnabled = false,
  mapStatus = "disabled",
  sessionlogSync = "off",
  teamName = "",
} = {}) {
  const isAgent = role !== null;
  const lines = ["## Swarm Capabilities", ""];

  // ── Team Orchestration ───────────────────────────────────────────────
  lines.push("### Team Orchestration");
  lines.push("");
  if (isAgent) {
    lines.push(`You are part of the **${teamName}** team. The orchestrator spawns and coordinates all teammates — spawned agents cannot spawn other agents.`);
  } else {
    lines.push("Use `/swarm` to launch a team from the configured topology, or `/swarm <template>` to pick a different one.");
    lines.push("Available templates: **gsd**, **bmad-method**, **bug-fix-pipeline**, **docs-sync**, **security-audit**, and more.");
    lines.push("Only the orchestrator spawns teammates — spawned agents cannot spawn other agents.");
  }
  lines.push("");

  // ── Task Management ──────────────────────────────────────────────────
  lines.push("### Task Management");
  lines.push("");
  const otActive = opentasksEnabled && (opentasksStatus === "connected" || opentasksStatus === "enabled");
  if (otActive) {
    lines.push("Use **opentasks MCP tools** for task management:");
    lines.push("- `opentasks__create_task` — create tasks with metadata and links");
    lines.push("- `opentasks__update_task` — claim, update status, annotate");
    lines.push("- `opentasks__list_tasks` / `opentasks__query` — check progress, filter by status/assignee");
    lines.push("Cross-system task graph supports linking (`opentasks__link`) and annotations.");
    lines.push("Native Claude tasks are auto-federated into the graph via the claude-tasks provider.");
  } else {
    lines.push("Use Claude Code native task tools:");
    lines.push("- `TaskCreate` — create tasks for the team");
    lines.push("- `TaskUpdate` — claim (set owner), update status");
    lines.push("- `TaskList` — check progress");
    lines.push("Tasks are shared team-wide when agents use the same `team_name`.");
  }
  lines.push("");

  // ── Communication ────────────────────────────────────────────────────
  lines.push("### Communication");
  lines.push("");
  lines.push("Use `SendMessage` for agent-to-agent messaging:");
  lines.push("- Direct: `SendMessage(recipient=\"<agent-name>\", content=\"...\")`");
  lines.push("- Broadcast only when truly necessary (messages every teammate).");
  if (inboxEnabled) {
    lines.push("Structured messaging via agent-inbox with threading and delivery tracking.");
  }
  if (meshEnabled) {
    lines.push("Encrypted P2P transport via MeshPeer with agent discovery.");
  }
  lines.push("");

  // ── Memory (minimem) ────────────────────────────────────────────────
  if (minimemEnabled && minimemStatus !== "disabled") {
    lines.push("### Memory");
    lines.push("");
    if (minimemStatus === "ready") {
      lines.push("Use **minimem MCP tools** to recall and store shared team knowledge:");
      lines.push("- `minimem__memory_search` — search past decisions, context, patterns");
      lines.push("- `minimem__memory_get_details` — full text for a result");
      lines.push("- `minimem__knowledge_search` — search with domain/entity filters");
      lines.push("- `minimem__knowledge_graph` / `minimem__knowledge_path` — explore relationships");
      lines.push("Search memory before starting major work for relevant prior context.");
      lines.push("Memory is shared team-wide — all agents see the same store.");
    } else {
      lines.push(`Memory: ${minimemStatus} (minimem installed but not fully ready).`);
    }
    lines.push("");
  }

  // ── Per-Role Skills (skill-tree) ─────────────────────────────────────
  if (skilltreeEnabled && skilltreeStatus !== "disabled") {
    lines.push("### Per-Role Skills");
    lines.push("");
    if (isAgent) {
      lines.push("Skill loadouts from team.yaml are compiled per-role and embedded in your prompt above.");
    } else {
      lines.push("Skill loadouts from team.yaml are compiled per-role and embedded in each agent's prompt at generation time.");
      lines.push("Skills are cached per template — delete the template cache to refresh.");
    }
    lines.push("");
  }

  // ── External Observability (MAP) ─────────────────────────────────────
  lines.push("### External Observability");
  lines.push("");
  if (mapEnabled) {
    if (isAgent) {
      lines.push("MAP is active — lifecycle and task events are emitted automatically by hooks. No direct interaction needed.");
    } else {
      lines.push(`MAP: ${mapStatus}`);
      lines.push("Agent lifecycle and task events are emitted automatically by hooks. No direct MAP interaction needed.");
    }
    if (sessionlogSync && sessionlogSync !== "off") {
      lines.push(`Session trajectory checkpoints synced to MAP (level: ${sessionlogSync}).`);
    }
  } else {
    lines.push("No external observability configured.");
  }
  lines.push("");

  return lines.join("\n");
}

// ── SessionStart context ─────────────────────────────────────────────────────

/**
 * Format the SessionStart bootstrap context.
 */
export function formatBootstrapContext({
  template,
  team,
  mapEnabled = false,
  mapStatus,
  sessionlogStatus,
  sessionlogSync,
  opentasksEnabled = false,
  opentasksStatus = "disabled",
  inboxEnabled = false,
  meshEnabled = false,
  minimemEnabled = false,
  minimemStatus = "disabled",
  skilltreeEnabled = false,
  skilltreeStatus = "disabled",
}) {
  const lines = ["## Claude Code Swarm", ""];

  if (template) {
    lines.push(`Team template configured: **${template}**`);
  } else {
    lines.push("No team template configured.");
  }
  lines.push("");

  // Sessionlog warning (non-capability — surface config issues)
  if (sessionlogStatus && sessionlogStatus !== "active" && sessionlogStatus !== "not installed") {
    lines.push(`Sessionlog: WARNING — configured but ${sessionlogStatus}`);
    lines.push("");
  }

  // Capabilities context
  lines.push(buildCapabilitiesContext({
    role: null,
    opentasksEnabled,
    opentasksStatus,
    minimemEnabled,
    minimemStatus,
    skilltreeEnabled,
    skilltreeStatus,
    inboxEnabled,
    meshEnabled,
    mapEnabled,
    mapStatus: mapStatus || "disabled",
    sessionlogSync: sessionlogSync || "off",
  }));

  if (team) {
    // Embed the SKILL.md content directly so the agent has the topology immediately
    const skillPath = `${team.outputDir}/SKILL.md`;
    try {
      const skillContent = fs.readFileSync(skillPath, "utf-8");
      lines.push(skillContent);
      lines.push("");
    } catch {
      // SKILL.md not readable — just show the path
    }

    lines.push(`Agent prompts: \`${team.outputDir}/agents/<role>.md\``);
    lines.push("");
  }

  lines.push(
    "Use `/swarm` to launch the team (creates a native Claude Code team)."
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Format the team-loaded context output.
 * Uses buildCapabilitiesContext for coordination/tool instructions.
 */
export function formatTeamLoadedContext(generatedDir, templatePath, teamName, options = {}) {
  const lines = ["## Claude Code Swarm — Team Loaded", ""];

  // Include the catalog if available
  const catalogPath = `${generatedDir}/SKILL.md`;
  try {
    const catalog = fs.readFileSync(catalogPath, "utf-8");
    lines.push(catalog);
  } catch {
    // No catalog available
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### Agent Team Instructions");
  lines.push("");
  lines.push(
    `A team topology has been loaded from \`${templatePath}\`. To launch this team:`
  );
  lines.push("");
  lines.push(
    "1. Call **TeamCreate** to set up a native Claude Code team"
  );
  lines.push(
    "2. Create tasks based on the user's goal"
  );
  lines.push(
    "3. Spawn agents directly as teammates (only you can spawn — teammates cannot spawn other teammates)"
  );
  lines.push(
    "4. Coordinate the team via **SendMessage** and track progress"
  );
  lines.push("");
  lines.push(
    `Per-role prompts are available at \`${generatedDir}/agents/<role>.md\``
  );
  lines.push(
    "Read a role's agent prompt before spawning an agent for that role."
  );
  lines.push("");

  // Capabilities context for coordination details
  lines.push(buildCapabilitiesContext({
    role: null,
    opentasksEnabled: options.opentasksEnabled,
    opentasksStatus: options.opentasksStatus || "disabled",
    minimemEnabled: options.minimemEnabled,
    minimemStatus: options.minimemStatus || "disabled",
    skilltreeEnabled: options.skilltreeEnabled,
    skilltreeStatus: options.skilltreeStatus || "disabled",
    inboxEnabled: options.inboxEnabled,
    meshEnabled: options.meshEnabled,
    mapEnabled: options.mapEnabled,
    mapStatus: options.mapStatus || "disabled",
    sessionlogSync: options.sessionlogSync || "off",
  }));

  return lines.join("\n");
}

/**
 * Format the "no template configured" message with available templates.
 */
export function formatNoTemplateMessage(templates) {
  const lines = [
    "## Claude Code Swarm",
    "",
    "No team template configured. Use `/swarm` to launch a team, or create `.swarm/claude-swarm/config.json` in your project:",
    "",
    "```json",
    "{",
    '  "template": "gsd"',
    "}",
    "```",
    "",
    "Available templates (via openteams):",
  ];

  for (const t of templates) {
    lines.push(`  - **${t.name}**: ${t.description}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format the "template not found" warning.
 */
export function formatTemplateNotFoundMessage(name) {
  return [
    "## Claude Code Swarm",
    "",
    `WARNING: Team template '${name}' not found.`,
    "Use `/swarm` to list and select an available template.",
    "",
  ].join("\n");
}
