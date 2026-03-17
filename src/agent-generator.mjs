/**
 * agent-generator.mjs — AGENT.md generation for claude-code-swarm
 *
 * Converts openteams YAML templates into Claude Code AGENT.md files.
 * Supports full openteams pipeline and a fallback basic YAML parser.
 */

import fs from "fs";
import path from "path";
import { buildCapabilitiesContext } from "./context-output.mjs";

/**
 * Parse team.yaml without js-yaml dependency (basic YAML subset).
 * Used as fallback when openteams is not installed.
 */
export function parseBasicYaml(content) {
  const lines = content.split("\n");
  const result = { roles: [], topology: { root: {} } };
  let currentKey = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      result.name = trimmed.replace("name:", "").trim().replace(/"/g, "");
    }
    if (trimmed.startsWith("description:")) {
      result.description = trimmed
        .replace("description:", "")
        .trim()
        .replace(/"/g, "");
    }
    if (trimmed === "roles:") {
      currentKey = "roles";
      continue;
    }
    if (currentKey === "roles" && trimmed.startsWith("- ")) {
      result.roles.push(trimmed.replace("- ", "").trim());
    }
    if (!trimmed.startsWith("- ") && trimmed.includes(":") && currentKey === "roles") {
      currentKey = "";
    }
  }
  return result;
}

/**
 * Determine which tools an agent needs based on role name, manifest, and position.
 */
export function determineTools(roleName, manifest, position, options = {}) {
  const tools = ["Read", "Glob", "Grep", "Bash"];

  if (options.opentasksEnabled) {
    tools.push("SendMessage");
  } else {
    tools.push("TaskList", "TaskUpdate", "SendMessage");
    if (position === "root" || position === "companion") {
      tools.push("TaskCreate");
    }
  }

  if (position === "root" || position === "companion") {
    tools.push("Write", "Edit");
  }

  // Keep existing writeRoles logic for code-writing roles
  const writeRoles = [
    "executor",
    "developer",
    "quick-flow-dev",
    "debugger",
    "tech-writer",
  ];
  if (writeRoles.includes(roleName) && !tools.includes("Write")) {
    tools.push("Write", "Edit");
  }

  return tools;
}

/**
 * Generate a Claude Code AGENT.md file content for a single role.
 */
export function generateAgentMd({
  roleName,
  teamName,
  position,
  description,
  model,
  tools,
  skillContent,
  manifest,
  opentasksEnabled,
  minimemEnabled,
  skillLoadout,
  skillProfile,
  // Capabilities context options (passed through to buildCapabilitiesContext)
  opentasksStatus,
  minimemStatus,
  skilltreeEnabled,
  skilltreeStatus,
  inboxEnabled,
  meshEnabled,
  mapEnabled,
  mapStatus,
  sessionlogSync,
}) {
  const lines = [];

  // Claude Code AGENT.md frontmatter
  lines.push("---");
  lines.push(`name: ${teamName}-${roleName}`);
  lines.push(`description: "${description.replace(/"/g, '\\"')}"`);
  if (model) {
    lines.push(`model: ${model}`);
  }
  if (tools && tools.length > 0) {
    lines.push(`tools: [${tools.join(", ")}]`);
  }
  lines.push("---");
  lines.push("");

  // The agent's prompt content (from openteams' generated SKILL.md or raw prompts)
  lines.push(skillContent);
  lines.push("");

  // Role-specific communication patterns from topology (unique per role, not in capabilities)
  if (manifest.communication?.routing?.peers) {
    const outbound = manifest.communication.routing.peers.filter(
      (r) => r.from === roleName
    );
    const inbound = manifest.communication.routing.peers.filter(
      (r) => r.to === roleName
    );
    if (outbound.length > 0 || inbound.length > 0) {
      lines.push("## Your Communication Patterns");
      lines.push("");
      for (const route of outbound) {
        const signals = route.signals?.join(", ") || "updates";
        lines.push(`- **Send** ${signals} to **${route.to}** via SendMessage`);
      }
      for (const route of inbound) {
        const signals = route.signals?.join(", ") || "updates";
        lines.push(`- **Receive** ${signals} from **${route.from}**`);
      }
      lines.push("");
    }
  }

  // Signals this role emits
  if (manifest.communication?.emissions?.[roleName]) {
    const emissions = manifest.communication.emissions[roleName];
    lines.push("## Signals You Emit");
    lines.push("");
    lines.push(
      "When these events occur, notify the relevant agents via SendMessage:"
    );
    for (const signal of emissions) {
      lines.push(`- **${signal}**`);
    }
    lines.push("");
  }

  // Signals this role subscribes to
  if (manifest.communication?.subscriptions?.[roleName]) {
    const subs = manifest.communication.subscriptions[roleName];
    lines.push("## Signals You Receive");
    lines.push("");
    lines.push("Watch for messages from teammates about:");
    for (const sub of subs) {
      const signals = sub.signals ? sub.signals.join(", ") : "all events";
      lines.push(`- Channel **${sub.channel}**: ${signals}`);
    }
    lines.push("");
  }

  // Skills section (skill-tree loadout — role-specific content, kept separate)
  if (skillLoadout) {
    lines.push("## Skills");
    lines.push("");
    lines.push(skillLoadout);
    lines.push("");
  }

  // Unified capabilities context (shared with main agent)
  lines.push(buildCapabilitiesContext({
    role: roleName,
    teamName,
    opentasksEnabled,
    opentasksStatus: opentasksStatus || (opentasksEnabled ? "enabled" : "disabled"),
    minimemEnabled,
    minimemStatus: minimemStatus || (minimemEnabled ? "ready" : "disabled"),
    skilltreeEnabled,
    skilltreeStatus: skilltreeStatus || (skilltreeEnabled ? "ready" : "disabled"),
    skillProfile: skillProfile || "",
    inboxEnabled,
    meshEnabled,
    mapEnabled,
    mapStatus: mapStatus || "disabled",
    sessionlogSync: sessionlogSync || "off",
  }));

  return lines.join("\n") + "\n";
}

/**
 * Generate AGENT.md files for all roles in a template.
 * Uses openteams TemplateLoader when available, falls back to basic YAML parsing.
 * Returns { success, roles: string[], error? }.
 */
export async function generateAllAgents(templateDir, outputDir, options = {}) {
  const absTemplateDir = path.resolve(templateDir);
  const absOutputDir = path.resolve(outputDir);

  const teamYaml = path.join(absTemplateDir, "team.yaml");
  if (!fs.existsSync(teamYaml)) {
    return { success: false, roles: [], error: `team.yaml not found in: ${absTemplateDir}` };
  }

  // Try openteams pipeline
  let TemplateLoader, generateAllRoleSkillMds;
  try {
    const pkg = "openteams";
    const openteams = await import(/* @vite-ignore */ pkg);
    TemplateLoader = openteams.TemplateLoader;
    generateAllRoleSkillMds = openteams.generateAllRoleSkillMds;
  } catch {
    TemplateLoader = null;
  }

  // Load skill loadouts if available (compiled by skilltree-client during team loading)
  // Format: { roleName: { content, profile } } (or legacy string format)
  let skillLoadouts = {};
  const loadoutsPath = path.join(absOutputDir, "..", "skill-loadouts.json");
  if (fs.existsSync(loadoutsPath)) {
    try {
      skillLoadouts = JSON.parse(fs.readFileSync(loadoutsPath, "utf-8"));
    } catch { /* ignore */ }
  }
  // Helper to extract content and profile from loadout entry (handles both formats)
  function getLoadout(roleName) {
    const entry = skillLoadouts[roleName];
    if (!entry) return { content: "", profile: "" };
    if (typeof entry === "string") return { content: entry, profile: "" };
    return { content: entry.content || "", profile: entry.profile || "" };
  }

  const generatedRoles = [];

  if (TemplateLoader) {
    const template = TemplateLoader.load(absTemplateDir);
    const teamName = template.manifest.name;
    const manifest = template.manifest;
    const roleSkillMds = generateAllRoleSkillMds(template, {
      teamName,
      includeSpawnSection: false,
      includeCliSection: false,
    });

    for (const roleSkill of roleSkillMds) {
      const roleName = roleSkill.role;
      const role = template.roles.get(roleName);

      let position = "spawned";
      let model = undefined;
      if (manifest.topology.root.role === roleName) {
        position = "root";
        model = manifest.topology.root.config?.model;
      } else if (manifest.topology.companions?.some((c) => c.role === roleName)) {
        position = "companion";
        const comp = manifest.topology.companions.find(
          (c) => c.role === roleName
        );
        model = comp?.config?.model;
      }

      const tools = determineTools(roleName, manifest, position, options);

      const agentMd = generateAgentMd({
        roleName,
        teamName,
        position,
        description: role?.description || `${roleName} agent in the ${teamName} team`,
        model,
        tools,
        skillContent: roleSkill.content,
        manifest,
        opentasksEnabled: options.opentasksEnabled,
        opentasksStatus: options.opentasksStatus,
        minimemEnabled: options.minimemEnabled,
        minimemStatus: options.minimemStatus,
        skilltreeEnabled: options.skilltreeEnabled,
        skilltreeStatus: options.skilltreeStatus,
        inboxEnabled: options.inboxEnabled,
        meshEnabled: options.meshEnabled,
        mapEnabled: options.mapEnabled,
        mapStatus: options.mapStatus,
        sessionlogSync: options.sessionlogSync,
        skillLoadout: getLoadout(roleName).content,
        skillProfile: getLoadout(roleName).profile,
      });

      const agentDir = path.join(absOutputDir, roleName);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "AGENT.md"), agentMd, "utf-8");
      generatedRoles.push(roleName);
    }
  } else {
    // Fallback: parse team.yaml manually
    const yamlContent = fs.readFileSync(teamYaml, "utf-8");
    const manifest = parseBasicYaml(yamlContent);

    for (const roleName of manifest.roles) {
      // Try to read the role's prompt file
      let prompt = "";
      const promptDir = path.join(absTemplateDir, "prompts", roleName);
      const promptFile = path.join(absTemplateDir, "prompts", `${roleName}.md`);

      if (fs.existsSync(promptDir) && fs.statSync(promptDir).isDirectory()) {
        const roleMd = path.join(promptDir, "ROLE.md");
        const promptMd = path.join(promptDir, "prompt.md");
        if (fs.existsSync(roleMd)) {
          prompt = fs.readFileSync(roleMd, "utf-8");
        } else if (fs.existsSync(promptMd)) {
          prompt = fs.readFileSync(promptMd, "utf-8");
        }
      } else if (fs.existsSync(promptFile)) {
        prompt = fs.readFileSync(promptFile, "utf-8");
      }

      const fallbackTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"];
      if (options.opentasksEnabled) {
        fallbackTools.push("SendMessage");
      } else {
        fallbackTools.push("TaskList", "TaskUpdate", "TaskCreate", "SendMessage");
      }

      const agentMd = generateAgentMd({
        roleName,
        teamName: manifest.name,
        position: "spawned",
        description: `${roleName} agent in the ${manifest.name} team`,
        tools: fallbackTools,
        opentasksEnabled: options.opentasksEnabled,
        opentasksStatus: options.opentasksStatus,
        minimemEnabled: options.minimemEnabled,
        minimemStatus: options.minimemStatus,
        skilltreeEnabled: options.skilltreeEnabled,
        skilltreeStatus: options.skilltreeStatus,
        inboxEnabled: options.inboxEnabled,
        meshEnabled: options.meshEnabled,
        mapEnabled: options.mapEnabled,
        mapStatus: options.mapStatus,
        sessionlogSync: options.sessionlogSync,
        skillLoadout: getLoadout(roleName).content,
        skillProfile: getLoadout(roleName).profile,
        skillContent: prompt
          ? `# Role: ${roleName}\n\nMember of the **${manifest.name}** team.\n\n## Instructions\n\n${prompt}`
          : `# Role: ${roleName}\n\nMember of the **${manifest.name}** team.`,
        manifest,
      });

      const agentDir = path.join(absOutputDir, roleName);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "AGENT.md"), agentMd, "utf-8");
      generatedRoles.push(roleName);
    }
  }

  return { success: true, roles: generatedRoles };
}
