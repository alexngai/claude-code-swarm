/**
 * config.mjs — Shared configuration parsing for claude-code-swarm
 *
 * Reads .claude-swarm.json and provides normalized config with defaults.
 * Used by bootstrap, hooks, sidecar, and team-loader.
 */

import fs from "fs";

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
 * Read and normalize .claude-swarm.json config.
 * Priority: SWARM_* env vars > config file > defaults.
 * Never throws — returns defaults on any error.
 */
export function readConfig(configPath = ".claude-swarm.json") {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Missing or invalid config file — raw stays empty, defaults apply
  }

  const server = envStr("SWARM_MAP_SERVER") ?? raw.map?.server ?? undefined;
  const explicitEnabled = envBool("SWARM_MAP_ENABLED") ?? (raw.map?.enabled === true ? true : undefined);

  // MAP is enabled if explicitly set OR if a server is configured
  const mapEnabled = explicitEnabled ?? (server !== undefined);

  return {
    template: envStr("SWARM_TEMPLATE") ?? raw.template ?? "",
    map: {
      enabled: mapEnabled,
      server: server || DEFAULTS.mapServer,
      scope: envStr("SWARM_MAP_SCOPE") ?? raw.map?.scope ?? "",
      systemId: envStr("SWARM_MAP_SYSTEM_ID") ?? raw.map?.systemId ?? DEFAULTS.mapSystemId,
      sidecar: envStr("SWARM_MAP_SIDECAR") ?? raw.map?.sidecar ?? DEFAULTS.mapSidecar,
    },
    sessionlog: {
      enabled: envBool("SWARM_SESSIONLOG_ENABLED") ?? Boolean(raw.sessionlog?.enabled),
      sync: envStr("SWARM_SESSIONLOG_SYNC") ?? raw.sessionlog?.sync ?? DEFAULTS.sessionlogSync,
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
