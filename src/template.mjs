/**
 * template.mjs — Template resolution and artifact generation for claude-code-swarm
 *
 * Delegates to the openteams package for template resolution, loading, and generation.
 * openteams provides: resolveTemplateName(), listAllTemplates(), TemplateLoader,
 * generateSkillMd(), generateAgentPrompts().
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { getGlobalNodeModules } from "./swarmkit-resolver.mjs";
import { teamDir } from "./paths.mjs";
import { writeRoles } from "./roles.mjs";
import { createLogger } from "./log.mjs";
import { materializeLoadout } from "./loadout-materializer.mjs";
import {
  checkMcpHealth,
  collectScopeReferences,
  discoverActiveSet,
} from "./mcp-health-checker.mjs";

const log = createLogger("template");
import { readConfig } from "./config.mjs";

const require = createRequire(import.meta.url);

let _openteams = undefined;

/**
 * Load the openteams module. Returns null if not available.
 * Tries local require first, then falls back to global node_modules.
 */
function loadOpenteams() {
  if (_openteams !== undefined) return _openteams;

  // 1. Local require (works if openteams is in node_modules or NODE_PATH)
  try {
    _openteams = require("openteams");
    return _openteams;
  } catch {
    // Not locally available
  }

  // 2. Global node_modules fallback (where swarmkit installs it)
  const globalNm = getGlobalNodeModules();
  if (globalNm) {
    const globalPath = path.join(globalNm, "openteams");
    if (fs.existsSync(globalPath)) {
      try {
        _openteams = require(globalPath);
        return _openteams;
      } catch {
        // require failed
      }
    }
  }

  _openteams = null;
  return null;
}

/**
 * Resolve a template name or path to an absolute directory path.
 * Delegates to openteams' resolveTemplateName() which checks:
 *   1. Direct path (absolute or relative)
 *   2. Project-local installed (.openteams/templates/)
 *   3. Global installed (~/.openteams/templates/)
 *   4. Built-in templates (bundled with openteams)
 * Returns null if not found.
 */
export function resolveTemplatePath(nameOrPath) {
  // Direct path (absolute or relative)
  if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isDirectory()) {
    return path.resolve(nameOrPath);
  }

  // Delegate to openteams resolver
  const ot = loadOpenteams();
  if (ot?.resolveTemplateName) {
    const resolved = ot.resolveTemplateName(nameOrPath);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * List available templates from openteams (installed + built-in).
 * Returns array of { name, description, path }.
 */
export function listAvailableTemplates() {
  const ot = loadOpenteams();
  if (ot?.listAllTemplates) {
    try {
      return ot.listAllTemplates().map((t) => ({
        name: t.name,
        description: t.description || "No description",
        path: t.path,
      }));
    } catch {
      // openteams available but listing failed
    }
  }
  return [];
}

/**
 * Parse a team.yaml manifest via openteams TemplateLoader.
 * Falls back to js-yaml if TemplateLoader is unavailable.
 */
export function readTeamManifest(templatePath) {
  const ot = loadOpenteams();
  if (ot?.TemplateLoader) {
    const resolved = ot.TemplateLoader.load(templatePath);
    return resolved.manifest;
  }
  // Fallback: direct YAML parse
  const yaml = require("js-yaml");
  const content = fs.readFileSync(
    path.join(templatePath, "team.yaml"),
    "utf-8"
  );
  return yaml.load(content);
}

/**
 * Load a team template: resolve path, generate artifacts (with cache), write roles.json.
 * Returns { success, templateName, templatePath, outputDir, teamName, cached, error? }.
 * Returns { success: false } if template not found or generation fails.
 */
export async function loadTeam(templateName) {
  const templatePath = resolveTemplatePath(templateName);
  if (!templatePath) {
    return { success: false, templateName, error: `Template '${templateName}' not found` };
  }

  const outputDir = teamDir(templateName);
  const cached = fs.existsSync(path.join(outputDir, "SKILL.md"));

  if (!cached) {
    const result = generateTeamArtifacts(templatePath, outputDir);
    if (!result.success) {
      return { success: false, templateName, templatePath, error: result.error };
    }
  }

  // Write roles.json for MAP hook integration
  writeRoles(templatePath);

  // Resolve team name from manifest
  let teamName = templateName;
  try {
    const manifest = readTeamManifest(templatePath);
    teamName = manifest.name || teamName;
  } catch {
    // Use template name as fallback
  }

  // Compile skill-tree loadouts if enabled (cached alongside template artifacts).
  // When openteams is available, we also pass the full ResolvedTemplate so
  // compileAllRoleLoadouts can read `role.loadout.skills` (first-class) in
  // addition to the legacy `skilltree:` extension.
  const config = readConfig();
  if (config.skilltree?.enabled) {
    const loadoutsPath = path.join(outputDir, "skill-loadouts.json");
    if (!fs.existsSync(loadoutsPath)) {
      try {
        const { compileAllRoleLoadouts } = await import("./skilltree-client.mjs");
        const manifest = readTeamManifest(templatePath);
        let template = null;
        const ot = loadOpenteams();
        if (ot?.TemplateLoader) {
          try {
            template = ot.TemplateLoader.load(templatePath);
          } catch (err) {
            log.warn("template load for skill-tree failed", { error: err.message });
          }
        }
        const loadouts = await compileAllRoleLoadouts(
          manifest,
          config.skilltree,
          template
        );
        if (Object.keys(loadouts).length > 0) {
          fs.writeFileSync(loadoutsPath, JSON.stringify(loadouts, null, 2), "utf-8");
        }
      } catch (err) {
        log.warn("skill loadout compilation failed", { error: err.message });
      }
    }
  }

  // Cache openteams loadout artifacts (per-role scope + providers + health report).
  // Always regenerates on loadTeam — fresh active-set discovery each session.
  try {
    cacheLoadoutArtifacts({ templatePath, outputDir, templateName, teamName });
  } catch (err) {
    log.warn("loadout artifact caching failed", { error: err.message });
  }

  return { success: true, templateName, templatePath, outputDir, teamName, cached };
}

/**
 * Materialize per-role loadout artifacts + team MCP state to the
 * per-template cache directory. Side-effecting; only writes under
 * `outputDir`. Best-effort — errors are logged but don't fail loadTeam.
 *
 * Written outputs (all under `outputDir`):
 *   loadouts/<role>.json   — openteams LoadoutArtifacts (inspection + debug)
 *   scope/<role>.json      — runtime scope file read by the scope-check hook
 *   mcp-providers.json     — team.mcp_providers as a plain object (when non-empty)
 *   mcp-health.json        — health report: ok / missing / refs / orphaned
 */
export function cacheLoadoutArtifacts({
  templatePath,
  outputDir,
  templateName,
  teamName,
} = {}) {
  const ot = loadOpenteams();
  if (!ot?.TemplateLoader) return;

  let template;
  try {
    template = ot.TemplateLoader.load(templatePath);
  } catch (err) {
    log.warn("template load failed during loadout caching", { error: err.message });
    return;
  }

  const loadouts = template?.roles ?? new Map();
  const providers = template?.mcpProviders ?? new Map();
  const name = teamName || template?.manifest?.name || templateName;

  // Per-role artifacts
  const loadoutsDir = path.join(outputDir, "loadouts");
  const scopeDir = path.join(outputDir, "scope");

  // Short-circuit if there are no loadouts at all — avoid creating empty dirs.
  const rolesWithLoadouts = [];
  for (const [roleName, role] of loadouts) {
    if (role?.loadout) rolesWithLoadouts.push([roleName, role]);
  }

  if (rolesWithLoadouts.length > 0) {
    fs.mkdirSync(loadoutsDir, { recursive: true });
    fs.mkdirSync(scopeDir, { recursive: true });

    for (const [roleName, role] of rolesWithLoadouts) {
      // Dump openteams' artifact view for debugging/observability.
      if (ot.generateLoadoutArtifacts) {
        try {
          const artifacts = ot.generateLoadoutArtifacts(role.loadout);
          fs.writeFileSync(
            path.join(loadoutsDir, `${roleName}.json`),
            JSON.stringify(artifacts, null, 2),
            "utf-8"
          );
        } catch (err) {
          log.warn("generateLoadoutArtifacts failed", {
            role: roleName,
            error: err.message,
          });
        }
      }

      // Scope file — consumed at runtime by scripts/scope-check.mjs
      const scopeFilePath = path.join(scopeDir, `${roleName}.json`);
      try {
        const { scopeFile, warnings } = materializeLoadout({
          role: {
            name: roleName,
            description: role.description,
            displayName: role.displayName,
          },
          loadout: role.loadout,
          template,
          options: { teamName: name, scopeFilePath },
        });
        fs.writeFileSync(
          scopeFilePath,
          JSON.stringify(scopeFile, null, 2),
          "utf-8"
        );
        for (const w of warnings) log.warn(w);
      } catch (err) {
        log.warn("scope-file materialization failed", {
          role: roleName,
          error: err.message,
        });
      }
    }
  }

  // Team-level providers map
  const providersObj =
    providers instanceof Map ? Object.fromEntries(providers) : providers || {};
  if (Object.keys(providersObj).length > 0) {
    fs.writeFileSync(
      path.join(outputDir, "mcp-providers.json"),
      JSON.stringify(providersObj, null, 2),
      "utf-8"
    );
  }

  // Health report — regenerated each session against current active set
  try {
    const pluginPath = process.env.CLAUDE_PLUGIN_ROOT;
    const activeSet = discoverActiveSet({
      projectPath: process.cwd(),
      pluginPath,
    });
    const scopeReferences = collectScopeReferences(template.loadouts ?? new Map());
    const report = checkMcpHealth({
      providers,
      activeSet,
      scopeReferences,
    });
    fs.writeFileSync(
      path.join(outputDir, "mcp-health.json"),
      JSON.stringify(report, null, 2),
      "utf-8"
    );
  } catch (err) {
    log.warn("mcp health check failed", { error: err.message });
  }
}

/**
 * Generate team artifacts (SKILL.md + agent prompts) using openteams.
 * Prefers programmatic API (generateSkillMd + generateAgentPrompts),
 * falls back to CLI if the API is unavailable.
 * outputDir is required — callers should use teamDir(templateName) from paths.mjs.
 * Returns { success, teamName, error? }.
 */
export function generateTeamArtifacts(templatePath, outputDir) {
  const ot = loadOpenteams();
  if (!ot) {
    return {
      success: false,
      teamName: "",
      error: "openteams not found. Run: swarmkit add openteams",
    };
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    // Load template
    const template = ot.TemplateLoader.load(templatePath);
    const teamName = template.manifest.name || path.basename(templatePath);

    // Generate SKILL.md (exclude spawn rules — main agent is the only spawner)
    const skillContent = ot.generateSkillMd(template, {
      teamName,
      includeSpawnRules: false,
    });
    fs.writeFileSync(path.join(outputDir, "SKILL.md"), skillContent, "utf-8");

    // Generate agent prompts (exclude spawn/CLI — teammates can't spawn, use native tools)
    const prompts = ot.generateAgentPrompts(template, {
      teamName,
      includeSpawnSection: false,
      includeCliSection: false,
    });
    const agentsDir = path.join(outputDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const agentPrompt of prompts) {
      fs.writeFileSync(
        path.join(agentsDir, `${agentPrompt.role}.md`),
        agentPrompt.prompt,
        "utf-8"
      );
    }

    return { success: true, teamName };
  } catch (err) {
    return {
      success: false,
      teamName: "",
      error: err.message,
    };
  }
}
