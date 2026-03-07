/**
 * config.mjs — Shared configuration parsing for claude-code-swarm
 *
 * Reads config with priority: env vars > project config > global config > defaults.
 * Project config: .swarm/claude-swarm/config.json (in cwd)
 * Global config:  ~/.claude-swarm/config.json
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
 * Deep merge two plain objects. Source values override target values.
 * Only merges plain objects — arrays and primitives are replaced.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Read and normalize config.
 * Priority: SWARM_* env vars > project config > global config > defaults.
 * Never throws — returns defaults on any error.
 */
export function readConfig(configPath = CONFIG_PATH, globalPath = GLOBAL_CONFIG_PATH) {
  const globalRaw = readJsonFile(globalPath);
  const projectRaw = readJsonFile(configPath);
  const raw = deepMerge(globalRaw, projectRaw);

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
      auth: {
        token: envStr("SWARM_MAP_AUTH_TOKEN") ?? raw.map?.auth?.token ?? "",
        param: envStr("SWARM_MAP_AUTH_PARAM") ?? raw.map?.auth?.param ?? "token",
      },
    },
    sessionlog: {
      enabled: envBool("SWARM_SESSIONLOG_ENABLED") ?? Boolean(raw.sessionlog?.enabled),
      sync: envStr("SWARM_SESSIONLOG_SYNC") ?? raw.sessionlog?.sync ?? DEFAULTS.sessionlogSync,
    },
  };
}

/**
 * Build the MAP server URL with auth query param if configured.
 * If the token is already in the server URL, returns as-is.
 */
export function resolveMapServer(config) {
  const server = config.map?.server || DEFAULTS.mapServer;
  const token = config.map?.auth?.token;
  if (!token) return server;

  // Don't double-add if token is already in the URL
  const url = new URL(server);
  const param = config.map?.auth?.param || "token";
  if (url.searchParams.has(param)) return server;

  url.searchParams.set(param, token);
  return url.toString();
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
