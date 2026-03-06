/**
 * config.mjs — Shared configuration parsing for claude-code-swarm
 *
 * Reads .swarm/claude/config.json and provides normalized config with defaults.
 * Used by bootstrap, hooks, sidecar, and team-loader.
 */

import fs from "fs";
import { CONFIG_PATH, GLOBAL_CONFIG_PATH } from "./paths.mjs";

export const DEFAULTS = {
  mapServer: "ws://localhost:8080",
  mapScope: "swarm:default",
  mapSystemId: "system-claude-swarm",
  mapSidecar: "session",
  sessionlogSync: "off",
};

/**
 * Read env var as boolean. Truthy: "true", "1", "yes" (case-insensitive).
 * Returns undefined if unset so ?? falls through to file/default.
 */
function envBool(name) {
  const val = process.env[name];
  if (val === undefined) return undefined;
  return ["true", "1", "yes"].includes(val.toLowerCase());
}

/**
 * Read env var as string. Returns undefined if unset or empty.
 */
function envStr(name) {
  return process.env[name] || undefined;
}

/**
 * Read a JSON config file. Returns empty object on any error.
 */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Read and normalize config with tiered resolution.
 * Priority: SWARM_* env vars > project config file > global config file > defaults.
 * Never throws — returns defaults on any error.
 */
export function readConfig(configPath = CONFIG_PATH, globalConfigPath = GLOBAL_CONFIG_PATH) {
  const global = readJsonFile(globalConfigPath);
  const project = readJsonFile(configPath);

  // Project overrides global for each field (not deep merge — per-field fallthrough)
  const server = envStr("SWARM_MAP_SERVER") ?? project.map?.server ?? global.map?.server ?? undefined;
  const explicitEnabled = envBool("SWARM_MAP_ENABLED") ?? (project.map?.enabled === true ? true : undefined) ?? (global.map?.enabled === true ? true : undefined);

  // MAP is enabled if explicitly set OR if a server is configured
  const mapEnabled = explicitEnabled ?? (server !== undefined);

  return {
    template: envStr("SWARM_TEMPLATE") ?? project.template ?? global.template ?? "",
    map: {
      enabled: mapEnabled,
      server: server || DEFAULTS.mapServer,
      scope: envStr("SWARM_MAP_SCOPE") ?? project.map?.scope ?? global.map?.scope ?? "",
      systemId: envStr("SWARM_MAP_SYSTEM_ID") ?? project.map?.systemId ?? global.map?.systemId ?? DEFAULTS.mapSystemId,
      sidecar: envStr("SWARM_MAP_SIDECAR") ?? project.map?.sidecar ?? global.map?.sidecar ?? DEFAULTS.mapSidecar,
    },
    sessionlog: {
      enabled: envBool("SWARM_SESSIONLOG_ENABLED") ?? Boolean(project.sessionlog?.enabled ?? global.sessionlog?.enabled),
      sync: envStr("SWARM_SESSIONLOG_SYNC") ?? project.sessionlog?.sync ?? global.sessionlog?.sync ?? DEFAULTS.sessionlogSync,
    },
  };
}

/**
 * Derive MAP scope from config.
 * Priority: explicit scope > swarm:<template> > swarm:default
 */
export function resolveScope(config) {
  if (config.map?.scope) return config.map.scope;
  if (config.template) return `swarm:${config.template}`;
  return DEFAULTS.mapScope;
}

/**
 * Derive team name from config (strip swarm: prefix from scope).
 */
export function resolveTeamName(config) {
  return resolveScope(config).replace("swarm:", "");
}
