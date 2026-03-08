import { describe, it, expect } from "vitest";
import * as index from "../index.mjs";

describe("index", () => {
  // Config exports
  it("exports readConfig", () => expect(typeof index.readConfig).toBe("function"));
  it("exports resolveScope", () => expect(typeof index.resolveScope).toBe("function"));
  it("exports resolveTeamName", () => expect(typeof index.resolveTeamName).toBe("function"));
  it("exports resolveMapServer", () => expect(typeof index.resolveMapServer).toBe("function"));
  it("exports DEFAULTS", () => expect(index.DEFAULTS).toBeDefined());

  // Path exports
  it("exports SOCKET_PATH", () => expect(typeof index.SOCKET_PATH).toBe("string"));
  it("exports INBOX_PATH", () => expect(typeof index.INBOX_PATH).toBe("string"));
  it("exports PID_PATH", () => expect(typeof index.PID_PATH).toBe("string"));
  it("exports ROLES_PATH", () => expect(typeof index.ROLES_PATH).toBe("string"));
  it("exports CONFIG_PATH", () => expect(typeof index.CONFIG_PATH).toBe("string"));
  it("exports GLOBAL_CONFIG_DIR", () => expect(typeof index.GLOBAL_CONFIG_DIR).toBe("string"));
  it("exports GLOBAL_CONFIG_PATH", () => expect(typeof index.GLOBAL_CONFIG_PATH).toBe("string"));
  it("exports TMP_DIR", () => expect(typeof index.TMP_DIR).toBe("string"));
  it("exports TEAMS_DIR", () => expect(typeof index.TEAMS_DIR).toBe("string"));
  it("exports teamDir", () => expect(typeof index.teamDir).toBe("function"));
  it("exports SWARM_DIR", () => expect(typeof index.SWARM_DIR).toBe("string"));
  it("exports SESSIONLOG_STATE_PATH", () => expect(typeof index.SESSIONLOG_STATE_PATH).toBe("string"));
  it("exports SESSIONLOG_DIR", () => expect(typeof index.SESSIONLOG_DIR).toBe("string"));
  it("exports MAP_DIR", () => expect(typeof index.MAP_DIR).toBe("string"));
  it("exports SIDECAR_LOG_PATH", () => expect(typeof index.SIDECAR_LOG_PATH).toBe("string"));
  it("exports IS_GLOBAL_PATHS", () => expect(typeof index.IS_GLOBAL_PATHS).toBe("boolean"));
  it("exports OPENTASKS_DIR", () => expect(typeof index.OPENTASKS_DIR).toBe("string"));
  it("exports OPENTASKS_SYNC_STATE_PATH", () => expect(typeof index.OPENTASKS_SYNC_STATE_PATH).toBe("string"));
  it("exports ensureSwarmDir", () => expect(typeof index.ensureSwarmDir).toBe("function"));
  it("exports ensureMapDir", () => expect(typeof index.ensureMapDir).toBe("function"));
  it("exports ensureOpentasksDir", () => expect(typeof index.ensureOpentasksDir).toBe("function"));
  it("exports pluginDir", () => expect(typeof index.pluginDir).toBe("function"));
  it("exports sessionPaths", () => expect(typeof index.sessionPaths).toBe("function"));
  it("exports ensureSessionDir", () => expect(typeof index.ensureSessionDir).toBe("function"));
  it("exports listSessionDirs", () => expect(typeof index.listSessionDirs).toBe("function"));

  // Roles exports
  it("exports readRoles", () => expect(typeof index.readRoles).toBe("function"));
  it("exports matchRole", () => expect(typeof index.matchRole).toBe("function"));
  it("exports writeRoles", () => expect(typeof index.writeRoles).toBe("function"));

  // Inbox exports
  it("exports readInbox", () => expect(typeof index.readInbox).toBe("function"));
  it("exports clearInbox", () => expect(typeof index.clearInbox).toBe("function"));
  it("exports writeToInbox", () => expect(typeof index.writeToInbox).toBe("function"));
  it("exports formatInboxAsMarkdown", () => expect(typeof index.formatInboxAsMarkdown).toBe("function"));
  it("exports formatAge", () => expect(typeof index.formatAge).toBe("function"));

  // Context output exports
  it("exports formatBootstrapContext", () => expect(typeof index.formatBootstrapContext).toBe("function"));
  it("exports formatTeamLoadedContext", () => expect(typeof index.formatTeamLoadedContext).toBe("function"));
  it("exports formatNoTemplateMessage", () => expect(typeof index.formatNoTemplateMessage).toBe("function"));
  it("exports formatTemplateNotFoundMessage", () => expect(typeof index.formatTemplateNotFoundMessage).toBe("function"));

  // MAP connection exports
  it("exports connectToMAP", () => expect(typeof index.connectToMAP).toBe("function"));
  it("exports fireAndForget", () => expect(typeof index.fireAndForget).toBe("function"));
  it("exports fireAndForgetTrajectory", () => expect(typeof index.fireAndForgetTrajectory).toBe("function"));

  // Sidecar client exports
  it("exports sendToSidecar", () => expect(typeof index.sendToSidecar).toBe("function"));
  it("exports isSidecarAlive", () => expect(typeof index.isSidecarAlive).toBe("function"));
  it("exports startSidecar", () => expect(typeof index.startSidecar).toBe("function"));
  it("exports killSidecar", () => expect(typeof index.killSidecar).toBe("function"));
  it("exports ensureSidecar", () => expect(typeof index.ensureSidecar).toBe("function"));

  // Sidecar server exports
  it("exports createSocketServer", () => expect(typeof index.createSocketServer).toBe("function"));
  it("exports createCommandHandler", () => expect(typeof index.createCommandHandler).toBe("function"));
  it("exports respond", () => expect(typeof index.respond).toBe("function"));

  // MAP events exports — sidecar commands and message payloads
  it("exports sendCommand", () => expect(typeof index.sendCommand).toBe("function"));
  it("exports emitPayload", () => expect(typeof index.emitPayload).toBe("function"));
  it("exports buildSpawnCommand", () => expect(typeof index.buildSpawnCommand).toBe("function"));
  it("exports buildDoneCommand", () => expect(typeof index.buildDoneCommand).toBe("function"));
  it("exports buildSubagentSpawnCommand", () => expect(typeof index.buildSubagentSpawnCommand).toBe("function"));
  it("exports buildSubagentDoneCommand", () => expect(typeof index.buildSubagentDoneCommand).toBe("function"));
  it("exports buildStateCommand", () => expect(typeof index.buildStateCommand).toBe("function"));
  it("exports buildTaskDispatchedPayload", () => expect(typeof index.buildTaskDispatchedPayload).toBe("function"));
  it("exports buildTaskCompletedPayload", () => expect(typeof index.buildTaskCompletedPayload).toBe("function"));
  it("exports buildTaskStatusPayload", () => expect(typeof index.buildTaskStatusPayload).toBe("function"));
  it("exports buildTaskSyncPayload", () => expect(typeof index.buildTaskSyncPayload).toBe("function"));
  it("exports buildOpentasksSyncPayload", () => expect(typeof index.buildOpentasksSyncPayload).toBe("function"));

  // Sessionlog exports
  it("exports checkSessionlogStatus", () => expect(typeof index.checkSessionlogStatus).toBe("function"));
  it("exports findActiveSession", () => expect(typeof index.findActiveSession).toBe("function"));
  it("exports buildTrajectoryCheckpoint", () => expect(typeof index.buildTrajectoryCheckpoint).toBe("function"));
  it("exports syncSessionlog", () => expect(typeof index.syncSessionlog).toBe("function"));

  // Template exports
  it("exports resolveTemplatePath", () => expect(typeof index.resolveTemplatePath).toBe("function"));
  it("exports listAvailableTemplates", () => expect(typeof index.listAvailableTemplates).toBe("function"));
  it("exports readTeamManifest", () => expect(typeof index.readTeamManifest).toBe("function"));
  it("exports generateTeamArtifacts", () => expect(typeof index.generateTeamArtifacts).toBe("function"));
  it("exports loadTeam", () => expect(typeof index.loadTeam).toBe("function"));

  // Agent generator exports
  it("exports parseBasicYaml", () => expect(typeof index.parseBasicYaml).toBe("function"));
  it("exports determineTools", () => expect(typeof index.determineTools).toBe("function"));
  it("exports generateAgentMd", () => expect(typeof index.generateAgentMd).toBe("function"));
  it("exports generateAllAgents", () => expect(typeof index.generateAllAgents).toBe("function"));

  // Swarmkit resolver exports
  it("exports getGlobalPrefix", () => expect(typeof index.getGlobalPrefix).toBe("function"));
  it("exports getGlobalNodeModules", () => expect(typeof index.getGlobalNodeModules).toBe("function"));
  it("exports configureNodePath", () => expect(typeof index.configureNodePath).toBe("function"));
  it("exports resolveSwarmkit", () => expect(typeof index.resolveSwarmkit).toBe("function"));

  // Opentasks client exports
  it("exports findSocketPath", () => expect(typeof index.findSocketPath).toBe("function"));
  it("exports rpcRequest", () => expect(typeof index.rpcRequest).toBe("function"));
  it("exports isDaemonAlive", () => expect(typeof index.isDaemonAlive).toBe("function"));
  it("exports ensureDaemon", () => expect(typeof index.ensureDaemon).toBe("function"));
  it("exports pushSyncEvent", () => expect(typeof index.pushSyncEvent).toBe("function"));

  // Bootstrap export
  it("exports bootstrap", () => expect(typeof index.bootstrap).toBe("function"));
});
