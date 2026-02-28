#!/usr/bin/env node
/**
 * generate-agents.mjs — Bridge between openteams templates and Claude Code AGENT.md files
 *
 * Usage: node generate-agents.mjs <template-dir> [output-dir]
 *
 * Takes an openteams team template directory and generates:
 *   agents/<role>/AGENT.md  — Claude Code agent definitions for each role
 *
 * These AGENT.md files follow the Claude Code plugin agent format so they
 * can be used directly by the Agent tool to spawn specialized teammates.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try to import openteams, fall back to parsing YAML directly
let TemplateLoader, generateRoleSkillMd, generateAllRoleSkillMds;
try {
  const openteams = await import("openteams");
  TemplateLoader = openteams.TemplateLoader;
  generateAllRoleSkillMds = openteams.generateAllRoleSkillMds;
  generateRoleSkillMd = openteams.generateRoleSkillMd;
} catch {
  // openteams not available — use built-in YAML parsing
  TemplateLoader = null;
}

const templateDir = process.argv[2];
const outputDir = process.argv[3] || path.join(process.cwd(), "agents");

if (!templateDir) {
  console.error("Usage: generate-agents.mjs <template-dir> [output-dir]");
  process.exit(1);
}

const absTemplateDir = path.resolve(templateDir);
const absOutputDir = path.resolve(outputDir);

if (!fs.existsSync(absTemplateDir)) {
  console.error(`Template directory not found: ${absTemplateDir}`);
  process.exit(1);
}

const teamYaml = path.join(absTemplateDir, "team.yaml");
if (!fs.existsSync(teamYaml)) {
  console.error(`team.yaml not found in: ${absTemplateDir}`);
  process.exit(1);
}

/**
 * Parse team.yaml without js-yaml dependency (basic YAML subset)
 */
function parseBasicYaml(content) {
  // This is a very simplified YAML parser for the team manifest structure
  // In practice, openteams should be installed and we use TemplateLoader
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

// ── Generate AGENT.md files ─────────────────────────────────────────────────

if (TemplateLoader) {
  // Full openteams pipeline: load template → generate per-role SKILL.md → wrap as AGENT.md
  console.log("Using openteams library for template loading...");

  const template = TemplateLoader.load(absTemplateDir);
  const teamName = template.manifest.name;
  const manifest = template.manifest;
  const roleSkillMds = generateAllRoleSkillMds(template, { teamName });

  for (const roleSkill of roleSkillMds) {
    const roleName = roleSkill.role;
    const role = template.roles.get(roleName);

    // Determine agent properties from topology
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

    // Determine which tools this agent needs
    const tools = determineTools(roleName, manifest, position);

    // Generate AGENT.md with Claude Code frontmatter
    const agentMd = generateAgentMd({
      roleName,
      teamName,
      position,
      description: role?.description || `${roleName} agent in the ${teamName} team`,
      model,
      tools,
      skillContent: roleSkill.content,
      manifest,
    });

    const agentDir = path.join(absOutputDir, roleName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENT.md"), agentMd, "utf-8");
    console.log(`  Generated: agents/${roleName}/AGENT.md`);
  }
} else {
  // Fallback: parse team.yaml manually and generate basic AGENT.md files
  console.log(
    "openteams library not available — using basic YAML parsing..."
  );
  console.log("Install openteams for full prompt generation: npm install -g openteams");

  const yamlContent = fs.readFileSync(teamYaml, "utf-8");
  const manifest = parseBasicYaml(yamlContent);

  for (const roleName of manifest.roles) {
    // Try to read the role's prompt file
    let prompt = "";
    const promptDir = path.join(absTemplateDir, "prompts", roleName);
    const promptFile = path.join(absTemplateDir, "prompts", `${roleName}.md`);

    if (fs.existsSync(promptDir) && fs.statSync(promptDir).isDirectory()) {
      // Directory-based prompts
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

    const agentMd = generateAgentMd({
      roleName,
      teamName: manifest.name,
      position: "spawned", // Can't determine without full parsing
      description: `${roleName} agent in the ${manifest.name} team`,
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
      skillContent: prompt
        ? `# Role: ${roleName}\n\nMember of the **${manifest.name}** team.\n\n## Instructions\n\n${prompt}`
        : `# Role: ${roleName}\n\nMember of the **${manifest.name}** team.`,
      manifest,
    });

    const agentDir = path.join(absOutputDir, roleName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENT.md"), agentMd, "utf-8");
    console.log(`  Generated: agents/${roleName}/AGENT.md`);
  }
}

console.log(`\nDone. Agent definitions written to: ${absOutputDir}`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function determineTools(roleName, manifest, position) {
  // Base tools all agents get
  const tools = ["Read", "Glob", "Grep", "Bash"];

  // Root and companions get full tool access + Agent spawning
  if (position === "root" || position === "companion") {
    tools.push("Write", "Edit", "Agent", "TodoWrite");
  }

  // Check spawn rules — if this role can spawn others, it needs Agent tool
  const spawnRules = manifest.topology?.spawn_rules?.[roleName];
  if (spawnRules && spawnRules.length > 0 && !tools.includes("Agent")) {
    tools.push("Agent");
  }

  // Roles that sound like they write code get write tools
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

function generateAgentMd({
  roleName,
  teamName,
  position,
  description,
  model,
  tools,
  skillContent,
  manifest,
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

  // Add openteams coordination instructions
  lines.push("## Team Coordination (openteams)");
  lines.push("");
  lines.push(
    `You are part of the **${teamName}** team. Use the openteams CLI for coordination:`
  );
  lines.push("");
  lines.push("```bash");
  lines.push(`# Check your tasks`);
  lines.push(`openteams task list ${teamName} --owner ${roleName}`);
  lines.push("");
  lines.push(`# Claim and start a task`);
  lines.push(
    `openteams task update ${teamName} <id> --owner ${roleName} --status in_progress`
  );
  lines.push("");
  lines.push(`# Complete a task`);
  lines.push(`openteams task update ${teamName} <id> --status completed`);
  lines.push("");
  lines.push(`# Check messages for you`);
  lines.push(
    `openteams message poll ${teamName} --agent ${roleName} --mark-delivered`
  );
  lines.push("");
  lines.push(`# Send a message to a teammate`);
  lines.push(
    `openteams message send ${teamName} --to <agent> --content "..." --summary "..."`
  );

  if (manifest.communication?.channels) {
    lines.push("");
    lines.push(`# Emit a signal`);
    lines.push(
      `openteams template emit ${teamName} -c <channel> -s <signal> --sender ${roleName}`
    );
    lines.push("");
    lines.push(`# Check events visible to your role`);
    lines.push(`openteams template events ${teamName} --role ${roleName}`);
  }
  lines.push("```");

  return lines.join("\n") + "\n";
}
