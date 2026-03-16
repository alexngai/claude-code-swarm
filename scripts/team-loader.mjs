#!/usr/bin/env node
/**
 * team-loader.mjs — Team loading script for claude-code-swarm
 *
 * Thin wrapper: resolves template, generates artifacts (with per-template caching),
 * writes roles.json, outputs context.
 *
 * Usage: node team-loader.mjs [template-name-or-path]
 */

import { readConfig } from "../src/config.mjs";
import {
  loadTeam,
  listAvailableTemplates,
} from "../src/template.mjs";
import {
  formatTeamLoadedContext,
  formatNoTemplateMessage,
  formatTemplateNotFoundMessage,
} from "../src/context-output.mjs";

const argTemplate = process.argv[2] || "";
const config = readConfig();

// ── Determine template name ─────────────────────────────────────────────────

let templateName = argTemplate || config.template;

// If no template, show available templates
if (!templateName) {
  const templates = listAvailableTemplates();
  process.stdout.write(formatNoTemplateMessage(templates));
  process.exit(0);
}

// ── Load team (resolve, generate/cache, write roles.json) ─────────────────

const result = await loadTeam(templateName);

if (!result.success) {
  if (!result.templatePath) {
    process.stdout.write(formatTemplateNotFoundMessage(templateName));
  } else {
    process.stdout.write(
      `## Claude Code Swarm\n\nWARNING: Failed to generate team artifacts from ${result.templatePath}\n${result.error || ""}\n`
    );
  }
  process.exit(0);
}

// ── Output context ──────────────────────────────────────────────────────────

process.stdout.write(formatTeamLoadedContext(result.outputDir, result.templatePath, result.teamName, {
  opentasksEnabled: config.opentasks?.enabled,
  opentasksStatus: config.opentasks?.enabled ? "enabled" : "disabled",
  minimemEnabled: config.minimem?.enabled,
  minimemStatus: config.minimem?.enabled ? "ready" : "disabled",
  skilltreeEnabled: config.skilltree?.enabled,
  skilltreeStatus: config.skilltree?.enabled ? "ready" : "disabled",
  inboxEnabled: config.inbox?.enabled,
  meshEnabled: config.mesh?.enabled,
  mapEnabled: config.map?.enabled,
  mapStatus: config.map?.enabled ? "enabled" : "disabled",
  sessionlogSync: config.sessionlog?.sync || "off",
}));
