/**
 * agent-generator.mjs — AGENT.md generation for claude-code-swarm
 *
 * Converts openteams YAML templates into Claude Code AGENT.md files.
 * Supports full openteams pipeline and a fallback basic YAML parser.
 */

import fs from "fs";
import path from "path";

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
export function determineTools(roleName, manifest, position) {
  const tools = ["Read", "Glob", "Grep", "Bash"];

  // All team agents get native team coordination tools
  tools.push("TaskList", "TaskUpdate", "SendMessage");

  // Root and companions get full tool access + Agent spawning + task creation
  if (position === "root" || position === "companion") {
    tools.push("Write", "Edit", "Agent", "TaskCreate");
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

  // Add team coordination instructions
  lines.push("## Team Coordination");
  lines.push("");
  lines.push(`You are part of the **${teamName}** team.`);
  lines.push("");

  // Communication via SendMessage
  lines.push("### Communication");
  lines.push("");
  lines.push("Use **SendMessage** to communicate with teammates:");
  lines.push(
    '- `SendMessage(type="message", recipient="<agent-name>", content="...", summary="...")`'
  );
  lines.push(
    "- Only use broadcast when absolutely necessary (it messages every teammate)."
  );
  lines.push("");

  // Add role-specific communication patterns from topology routing
  if (manifest.communication?.routing?.peers) {
    const outbound = manifest.communication.routing.peers.filter(
      (r) => r.from === roleName
    );
    const inbound = manifest.communication.routing.peers.filter(
      (r) => r.to === roleName
    );
    if (outbound.length > 0 || inbound.length > 0) {
      lines.push("#### Your communication patterns");
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

  // Signals this role emits — now via SendMessage
  if (manifest.communication?.emissions?.[roleName]) {
    const emissions = manifest.communication.emissions[roleName];
    lines.push("#### Signals you emit");
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
    lines.push("#### Signals you receive");
    lines.push("");
    lines.push("Watch for messages from teammates about:");
    for (const sub of subs) {
      const signals = sub.signals ? sub.signals.join(", ") : "all events";
      lines.push(`- Channel **${sub.channel}**: ${signals}`);
    }
    lines.push("");
  }

  // Task management via native tools
  lines.push("### Task Management");
  lines.push("");
  lines.push("Use Claude Code's native task tools:");
  lines.push(
    "- **TaskList** — check available tasks and their status"
  );
  lines.push(
    "- **TaskUpdate** — claim tasks (set owner to your name), update status to in_progress or completed"
  );
  if (position === "root" || position === "companion") {
    lines.push(
      "- **TaskCreate** — create new tasks for the team when you identify additional work"
    );
  }
  lines.push("");
  lines.push(
    "After completing a task, mark it completed with TaskUpdate, then check TaskList for your next assignment."
  );
  lines.push("");

  // Optional MAP note
  lines.push("### External Observability (MAP)");
  lines.push("");
  lines.push(
    "If MAP is enabled, lifecycle events are automatically emitted for external dashboards."
  );
  lines.push(
    "You do not need to interact with MAP directly — it is handled by hooks."
  );

  return lines.join("\n") + "\n";
}

/**
 * Generate AGENT.md files for all roles in a template.
 * Uses openteams TemplateLoader when available, falls back to basic YAML parsing.
 * Returns { success, roles: string[], error? }.
 */
export async function generateAllAgents(templateDir, outputDir) {
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

  const generatedRoles = [];

  if (TemplateLoader) {
    const template = TemplateLoader.load(absTemplateDir);
    const teamName = template.manifest.name;
    const manifest = template.manifest;
    const roleSkillMds = generateAllRoleSkillMds(template, { teamName });

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

      const tools = determineTools(roleName, manifest, position);

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

      const agentMd = generateAgentMd({
        roleName,
        teamName: manifest.name,
        position: "spawned",
        description: `${roleName} agent in the ${manifest.name} team`,
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "TaskList", "TaskUpdate", "TaskCreate", "SendMessage"],
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
