/**
 * index.mjs — Public API barrel export for claude-code-swarm
 */

// Config
export { readConfig, resolveScope, resolveTeamName, DEFAULTS } from "./config.mjs";

// Paths
export {
  SWARM_DIR,
  SOCKET_PATH,
  INBOX_PATH,
  PID_PATH,
  ROLES_PATH,
  SESSIONLOG_STATE_PATH,
  CONFIG_PATH,
  SESSIONLOG_DIR,
  TMP_DIR,
  TEAMS_DIR,
  MAP_DIR,
  SIDECAR_LOG_PATH,
  teamDir,
  ensureSwarmDir,
  ensureMapDir,
  pluginDir,
} from "./paths.mjs";

// Roles
export { readRoles, matchRole, writeRoles } from "./roles.mjs";

// Inbox
export { readInbox, clearInbox, writeToInbox, formatInboxAsMarkdown, formatAge } from "./inbox.mjs";

// Context output
export {
  formatBootstrapContext,
  formatTeamLoadedContext,
  formatNoTemplateMessage,
  formatTemplateNotFoundMessage,
} from "./context-output.mjs";

// MAP connection
export { connectToMAP, fireAndForget, fireAndForgetTrajectory } from "./map-connection.mjs";

// Sidecar client
export { sendToSidecar, isSidecarAlive, startSidecar, killSidecar, ensureSidecar } from "./sidecar-client.mjs";

// Sidecar server
export { createSocketServer, createCommandHandler, respond } from "./sidecar-server.mjs";

// MAP events — sidecar commands and message payloads (no custom swarm.* types)
export {
  sendCommand,
  emitPayload,
  buildSpawnCommand,
  buildDoneCommand,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  buildTaskDispatchedPayload,
  buildTaskCompletedPayload,
  buildTaskStatusPayload,
} from "./map-events.mjs";

// Sessionlog
export {
  checkSessionlogStatus,
  findActiveSession,
  buildTrajectoryCheckpoint,
  syncSessionlog,
} from "./sessionlog.mjs";

// Template
export {
  resolveTemplatePath,
  listAvailableTemplates,
  readTeamManifest,
  generateTeamArtifacts,
} from "./template.mjs";

// Agent generator
export {
  parseBasicYaml,
  determineTools,
  generateAgentMd,
  generateAllAgents,
} from "./agent-generator.mjs";

// Swarmkit resolver
export {
  getGlobalPrefix,
  getGlobalNodeModules,
  configureNodePath,
  resolveSwarmkit,
} from "./swarmkit-resolver.mjs";

// Bootstrap
export { bootstrap } from "./bootstrap.mjs";
