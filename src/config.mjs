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
 * Read and normalize .claude-swarm.json config.
 * Never throws — returns defaults on any error.
 */
export function readConfig(configPath = ".claude-swarm.json") {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      template: raw.template || "",
      map: {
        enabled: Boolean(raw.map?.enabled),
        server: raw.map?.server || DEFAULTS.mapServer,
        scope: raw.map?.scope || "",
        systemId: raw.map?.systemId || DEFAULTS.mapSystemId,
        sidecar: raw.map?.sidecar || DEFAULTS.mapSidecar,
      },
      sessionlog: {
        enabled: Boolean(raw.sessionlog?.enabled),
        sync: raw.sessionlog?.sync || DEFAULTS.sessionlogSync,
      },
    };
  } catch {
    return {
      template: "",
      map: {
        enabled: false,
        server: DEFAULTS.mapServer,
        scope: "",
        systemId: DEFAULTS.mapSystemId,
        sidecar: DEFAULTS.mapSidecar,
      },
      sessionlog: {
        enabled: false,
        sync: DEFAULTS.sessionlogSync,
      },
    };
  }
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
