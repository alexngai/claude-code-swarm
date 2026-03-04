/**
 * template.mjs — Template resolution and artifact generation for claude-code-swarm
 *
 * Resolves team template paths via openteams and runs openteams to generate agent definitions.
 * Templates are provided by the openteams package (installed via swarmkit), not bundled.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createRequire } from "module";
import { pluginDir } from "./paths.mjs";

const require = createRequire(import.meta.url);

/**
 * Resolve a template name or path to an absolute directory path.
 * Resolution priority: direct path → openteams registry.
 * Returns null if not found.
 */
export function resolveTemplatePath(nameOrPath, pluginDirOverride) {
  const dir = pluginDirOverride || pluginDir();

  // Direct path (absolute or relative)
  if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isDirectory()) {
    return path.resolve(nameOrPath);
  }

  // openteams registry (includes get-shit-done, bmad-method, and more)
  const openteamsBin = resolveOpenteamsBin(dir);
  if (openteamsBin) {
    try {
      const output = execSync(`${openteamsBin} template list --json`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const data = JSON.parse(output);
      const match = data.find((t) => t.name === nameOrPath);
      if (match?.path && fs.existsSync(match.path)) {
        return match.path;
      }
    } catch {
      // openteams not available or failed
    }
  }

  return null;
}

/**
 * List available templates from the openteams registry.
 * Returns array of { name, description, path }.
 */
export function listAvailableTemplates(pluginDirOverride) {
  const dir = pluginDirOverride || pluginDir();
  const openteamsBin = resolveOpenteamsBin(dir);
  const templates = [];

  if (openteamsBin) {
    try {
      const output = execSync(`${openteamsBin} template list --json`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const data = JSON.parse(output);
      for (const t of data) {
        templates.push({
          name: t.name,
          description: t.description || "No description",
          path: t.path,
        });
      }
    } catch {
      // openteams not available
    }
  }

  return templates;
}

/**
 * Parse a team.yaml manifest using js-yaml.
 */
export function readTeamManifest(templatePath) {
  const yaml = loadJsYaml();
  const content = fs.readFileSync(
    path.join(templatePath, "team.yaml"),
    "utf-8"
  );
  return yaml.load(content);
}

/**
 * Generate team artifacts using openteams CLI.
 * outputDir is required — callers should use teamDir(templateName) from paths.mjs.
 * Returns { success, teamName, error? }.
 */
export function generateTeamArtifacts(templatePath, outputDir) {
  const dir = pluginDir();
  const openteamsBin = resolveOpenteamsBin(dir);

  if (!openteamsBin) {
    return {
      success: false,
      teamName: "",
      error: "openteams not found. Run: swarmkit add openteams",
    };
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    execSync(`${openteamsBin} generate all "${templatePath}" -o "${outputDir}"`, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Extract team name
    let teamName = path.basename(templatePath);
    try {
      const manifest = readTeamManifest(templatePath);
      teamName = manifest.name || teamName;
    } catch {
      // Use directory name as fallback
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

/**
 * Build the shell command prefix for running the openteams CLI.
 * Returns a string ready to be used as: `${prefix} generate all ...`
 * Returns null if openteams is not available.
 *
 * Resolution order:
 * 1. Global openteams binary (primary path with swarmkit management)
 * 2. node_modules/.bin/openteams (local fallback)
 * 3. node_modules/openteams/dist/cjs/cli.js (legacy fallback)
 */
function resolveOpenteamsBin(pluginDirPath) {
  // 1. Global binary (expected path when installed via swarmkit)
  try {
    execSync("which openteams", { stdio: "ignore" });
    return "openteams";
  } catch {
    // Not globally installed
  }

  // 2. Local bin fallback
  const localBin = path.join(pluginDirPath, "node_modules", ".bin", "openteams");
  if (fs.existsSync(localBin)) return `"${localBin}"`;

  // 3. Legacy fallback for broken bin entries
  const cjsCli = path.join(pluginDirPath, "node_modules", "openteams", "dist", "cjs", "cli.js");
  if (fs.existsSync(cjsCli)) return `node "${cjsCli}"`;

  return null;
}

/**
 * Load js-yaml synchronously.
 */
function loadJsYaml() {
  return require("js-yaml");
}
