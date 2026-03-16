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
      auth: {
        token: envStr("SWARM_MAP_AUTH_TOKEN") ?? project.map?.auth?.token ?? global.map?.auth?.token ?? "",
        param: envStr("SWARM_MAP_AUTH_PARAM") ?? project.map?.auth?.param ?? global.map?.auth?.param ?? "token",
      },
    },
    sessionlog: {
      enabled: envBool("SWARM_SESSIONLOG_ENABLED") ?? Boolean(project.sessionlog?.enabled ?? global.sessionlog?.enabled),
      sync: envStr("SWARM_SESSIONLOG_SYNC") ?? project.sessionlog?.sync ?? global.sessionlog?.sync ?? DEFAULTS.sessionlogSync,
    },
    opentasks: {
      enabled: envBool("SWARM_OPENTASKS_ENABLED") ?? Boolean(project.opentasks?.enabled ?? global.opentasks?.enabled),
      autoStart: envBool("SWARM_OPENTASKS_AUTOSTART") ?? (project.opentasks?.autoStart ?? global.opentasks?.autoStart) !== false,
      scope: envStr("SWARM_OPENTASKS_SCOPE") ?? project.opentasks?.scope ?? global.opentasks?.scope ?? "tasks",
    },
    inbox: {
      enabled: envBool("SWARM_INBOX_ENABLED") ?? project.inbox?.enabled ?? global.inbox?.enabled ?? mapEnabled,
      sqlite: envStr("SWARM_INBOX_SQLITE") ?? project.inbox?.sqlite ?? global.inbox?.sqlite ?? "",
      httpPort: parseInt(envStr("SWARM_INBOX_HTTP_PORT") ?? project.inbox?.httpPort ?? "0", 10) || 0,
      webhooks: project.inbox?.webhooks ?? global.inbox?.webhooks ?? [],
      federation: {
        peers: project.inbox?.federation?.peers ?? global.inbox?.federation?.peers ?? [],
        routing: project.inbox?.federation?.routing ?? global.inbox?.federation?.routing ?? undefined,
        trust: project.inbox?.federation?.trust ?? global.inbox?.federation?.trust ?? undefined,
      },
    },
    minimem: {
      enabled: envBool("SWARM_MINIMEM_ENABLED") ?? Boolean(project.minimem?.enabled ?? global.minimem?.enabled),
      provider: envStr("SWARM_MINIMEM_PROVIDER") ?? project.minimem?.provider ?? global.minimem?.provider ?? "auto",
      global: envBool("SWARM_MINIMEM_GLOBAL") ?? Boolean(project.minimem?.global ?? global.minimem?.global),
      dir: envStr("SWARM_MINIMEM_DIR") ?? project.minimem?.dir ?? global.minimem?.dir ?? "",
    },
    skilltree: {
      enabled: envBool("SWARM_SKILLTREE_ENABLED") ?? Boolean(project.skilltree?.enabled ?? global.skilltree?.enabled),
      basePath: envStr("SWARM_SKILLTREE_BASE_PATH") ?? project.skilltree?.basePath ?? global.skilltree?.basePath ?? "",
      defaultProfile: envStr("SWARM_SKILLTREE_DEFAULT_PROFILE") ?? project.skilltree?.defaultProfile ?? global.skilltree?.defaultProfile ?? "",
    },
    mesh: {
      enabled: envBool("SWARM_MESH_ENABLED") ?? Boolean(project.mesh?.enabled ?? global.mesh?.enabled),
      peerId: envStr("SWARM_MESH_PEER_ID") ?? project.mesh?.peerId ?? global.mesh?.peerId ?? "",
      mapServer: envStr("SWARM_MESH_MAP_SERVER") ?? project.mesh?.mapServer ?? global.mesh?.mapServer ?? "",
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
