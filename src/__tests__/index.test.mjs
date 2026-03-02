import { describe, it, expect } from "vitest";
import * as index from "../index.mjs";

describe("index", () => {
  // Config exports
  it("exports readConfig", () => expect(typeof index.readConfig).toBe("function"));
  it("exports resolveScope", () => expect(typeof index.resolveScope).toBe("function"));
  it("exports resolveTeamName", () => expect(typeof index.resolveTeamName).toBe("function"));
  it("exports DEFAULTS", () => expect(index.DEFAULTS).toBeDefined());

  // Path exports
  it("exports SOCKET_PATH", () => expect(typeof index.SOCKET_PATH).toBe("string"));
  it("exports INBOX_PATH", () => expect(typeof index.INBOX_PATH).toBe("string"));
  it("exports PID_PATH", () => expect(typeof index.PID_PATH).toBe("string"));
  it("exports ROLES_PATH", () => expect(typeof index.ROLES_PATH).toBe("string"));
  it("exports CONFIG_PATH", () => expect(typeof index.CONFIG_PATH).toBe("string"));
  it("exports ensureMapDir", () => expect(typeof index.ensureMapDir).toBe("function"));
  it("exports pluginDir", () => expect(typeof index.pluginDir).toBe("function"));

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

  // MAP events exports
  it("exports emitEvent", () => expect(typeof index.emitEvent).toBe("function"));
  it("exports buildSpawnEvent", () => expect(typeof index.buildSpawnEvent).toBe("function"));
  it("exports buildCompletedEvent", () => expect(typeof index.buildCompletedEvent).toBe("function"));
  it("exports buildTaskDispatchedEvent", () => expect(typeof index.buildTaskDispatchedEvent).toBe("function"));
  it("exports buildTaskCompletedEvent", () => expect(typeof index.buildTaskCompletedEvent).toBe("function"));
  it("exports buildTurnCompletedEvent", () => expect(typeof index.buildTurnCompletedEvent).toBe("function"));
  it("exports buildSubagentStartEvent", () => expect(typeof index.buildSubagentStartEvent).toBe("function"));
  it("exports buildSubagentStopEvent", () => expect(typeof index.buildSubagentStopEvent).toBe("function"));
  it("exports buildTeammateIdleEvent", () => expect(typeof index.buildTeammateIdleEvent).toBe("function"));
  it("exports buildTaskStatusCompletedEvent", () => expect(typeof index.buildTaskStatusCompletedEvent).toBe("function"));

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

  // Agent generator exports
  it("exports parseBasicYaml", () => expect(typeof index.parseBasicYaml).toBe("function"));
  it("exports determineTools", () => expect(typeof index.determineTools).toBe("function"));
  it("exports generateAgentMd", () => expect(typeof index.generateAgentMd).toBe("function"));
  it("exports generateAllAgents", () => expect(typeof index.generateAllAgents).toBe("function"));

  // Bootstrap export
  it("exports bootstrap", () => expect(typeof index.bootstrap).toBe("function"));
});
