/**
 * context-output.mjs — Markdown formatting for hook stdout
 *
 * Generates the markdown context that gets injected into Claude's conversation
 * by SessionStart and team-loader hooks.
 */

import fs from "fs";

/**
 * Format the SessionStart bootstrap context.
 */
export function formatBootstrapContext({
  template,
  team,
  mapStatus,
  sessionlogStatus,
  sessionlogSync,
  opentasksStatus,
  inboxEnabled,
}) {
  const lines = ["## Claude Code Swarm", ""];

  if (template) {
    lines.push(`Team template configured: **${template}**`);
  } else {
    lines.push("No team template configured.");
  }

  if (mapStatus) {
    lines.push(`MAP: ${mapStatus}`);
  }

  if (sessionlogStatus) {
    if (sessionlogStatus === "active") {
      let syncLabel = "";
      if (sessionlogSync && sessionlogSync !== "off") {
        syncLabel = ` (MAP sync: ${sessionlogSync})`;
      }
      lines.push(`Sessionlog: active${syncLabel}`);
    } else if (sessionlogStatus !== "not installed") {
      lines.push(`Sessionlog: WARNING — configured but ${sessionlogStatus}`);
    }
  }

  if (opentasksStatus) {
    lines.push(`opentasks: ${opentasksStatus}`);
  }

  if (inboxEnabled) {
    lines.push("Inbox: enabled (agent-inbox messaging)");
  }

  lines.push("");

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
  lines.push("Templates available via openteams: **gsd**, **bmad-method**, **bug-fix-pipeline**, **docs-sync** (and more)");
  lines.push("");

  return lines.join("\n");
}

/**
 * Format the team-loaded context output.
 */
export function formatTeamLoadedContext(generatedDir, templatePath, teamName) {
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
    "2. Create tasks via **TaskCreate** based on the user's goal"
  );
  lines.push(
    "3. Spawn agents directly as teammates (only you can spawn — teammates cannot spawn other teammates)"
  );
  lines.push(
    "4. Coordinate the team via **SendMessage** and track progress via **TaskUpdate**"
  );
  lines.push("");
  lines.push(
    `Per-role prompts are available at \`${generatedDir}/agents/<role>.md\``
  );
  lines.push(
    "Read a role's agent prompt before spawning an agent for that role."
  );
  lines.push("");
  lines.push("### Coordination");
  lines.push("");
  lines.push("This team uses Claude Code's native team features:");
  lines.push("- **TaskCreate/TaskUpdate** for task lifecycle");
  lines.push("- **SendMessage** for agent-to-agent communication");
  lines.push("- **TeamCreate** for team setup");
  lines.push("");
  lines.push(
    "**MAP (if enabled):** Lifecycle events are emitted for external observability."
  );
  lines.push("Agents do not interact with MAP directly.");
  lines.push("");

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
