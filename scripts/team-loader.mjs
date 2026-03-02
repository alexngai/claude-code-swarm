#!/usr/bin/env node
/**
 * team-loader.mjs — Team loading script for claude-code-swarm
 *
 * Thin wrapper: resolves template, generates artifacts, writes roles.json,
 * outputs context. Replaces team-loader.sh.
 *
 * Usage: node team-loader.mjs [template-name-or-path] [plugin-dir]
 */

import { readConfig } from "../src/config.mjs";
import {
  resolveTemplatePath,
  listAvailableTemplates,
  generateTeamArtifacts,
  readTeamManifest,
} from "../src/template.mjs";
import { writeRoles } from "../src/roles.mjs";
import {
  formatTeamLoadedContext,
  formatNoTemplateMessage,
  formatTemplateNotFoundMessage,
} from "../src/context-output.mjs";
import { GENERATED_DIR } from "../src/paths.mjs";

const argTemplate = process.argv[2] || "";

// ── Determine template name ─────────────────────────────────────────────────

let templateName = argTemplate;

// Fall back to config file
if (!templateName) {
  const config = readConfig();
  templateName = config.template;
}

// If no template, show available templates
if (!templateName) {
  const templates = listAvailableTemplates();
  process.stdout.write(formatNoTemplateMessage(templates));
  process.exit(0);
}

// ── Resolve template path ───────────────────────────────────────────────────

const templatePath = resolveTemplatePath(templateName);

if (!templatePath) {
  process.stdout.write(formatTemplateNotFoundMessage(templateName));
  process.exit(0);
}

// ── Generate team artifacts ─────────────────────────────────────────────────

const result = generateTeamArtifacts(templatePath);

if (!result.success) {
  process.stdout.write(
    `## Claude Code Swarm\n\nWARNING: Failed to generate team artifacts from ${templatePath}\n${result.error || ""}\n`
  );
  process.exit(0);
}

// ── Write roles.json for MAP hook integration ───────────────────────────────

writeRoles(templatePath);

// ── Output context ──────────────────────────────────────────────────────────

const teamName = result.teamName;
process.stdout.write(formatTeamLoadedContext(GENERATED_DIR, templatePath, teamName));
