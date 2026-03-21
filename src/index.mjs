/**
 * index.mjs — Public API barrel export for claude-code-swarm
 */

// Config
export { readConfig, resolveScope, resolveTeamName, resolveMapServer, DEFAULTS } from "./config.mjs";

// Paths
export {
  SWARM_DIR,
  SOCKET_PATH,
  PID_PATH,
  ROLES_PATH,
  SESSIONLOG_STATE_PATH,
  CONFIG_PATH,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_PATH,
  SESSIONLOG_DIR,
  TMP_DIR,
  TEAMS_DIR,
  MAP_DIR,
  SIDECAR_LOG_PATH,
  IS_GLOBAL_PATHS,
  OPENTASKS_DIR,
  OPENTASKS_SYNC_STATE_PATH,
  teamDir,
  ensureSwarmDir,
  ensureMapDir,
  ensureOpentasksDir,
  pluginDir,
  sessionPaths,
  ensureSessionDir,
  listSessionDirs,
} from "./paths.mjs";

// Roles
export { readRoles, matchRole, writeRoles } from "./roles.mjs";

// Inbox
export { formatInboxAsMarkdown, formatAge } from "./inbox.mjs";

// Context output
export {
  buildCapabilitiesContext,
  formatBootstrapContext,
  formatTeamLoadedContext,
  formatNoTemplateMessage,
  formatTemplateNotFoundMessage,
} from "./context-output.mjs";

// MAP connection
export { connectToMAP, fireAndForget, fireAndForgetTrajectory } from "./map-connection.mjs";

// Mesh connection
export { createMeshPeer, createMeshInbox, meshFireAndForget } from "./mesh-connection.mjs";

// Sidecar client
export { sendToSidecar, isSidecarAlive, startSidecar, killSidecar, ensureSidecar } from "./sidecar-client.mjs";

// Sidecar server
export { createSocketServer, createCommandHandler, respond } from "./sidecar-server.mjs";

// MAP events — sidecar commands and message payloads (no custom swarm.* types)
export {
  sendCommand,
  emitPayload,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  handleTaskCreated,
  handleTaskCompleted,
  handleTaskStatusCompleted,
  buildTaskSyncPayload,
  buildOpentasksBridgeCommands,
  mapNativeTaskStatus,
  handleNativeTaskCreatedEvent,
  handleNativeTaskUpdatedEvent,
} from "./map-events.mjs";

// Sessionlog
export {
  checkSessionlogStatus,
  findActiveSession,
  buildTrajectoryCheckpoint,
  syncSessionlog,
  annotateSwarmSession,
} from "./sessionlog.mjs";

// Template
export {
  resolveTemplatePath,
  listAvailableTemplates,
  readTeamManifest,
  generateTeamArtifacts,
  loadTeam,
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

// opentasks client
export {
  findSocketPath,
  rpcRequest,
  isDaemonAlive,
  ensureDaemon,
  pushSyncEvent,
} from "./opentasks-client.mjs";

// Skill-tree client
export {
  parseSkillTreeExtension,
  compileRoleLoadout,
  compileAllRoleLoadouts,
  inferProfileFromRole,
} from "./skilltree-client.mjs";

// Logging
export { createLogger, init as initLog } from "./log.mjs";

// Bootstrap
export { bootstrap } from "./bootstrap.mjs";
