import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSpawnEvent,
  buildCompletedEvent,
  buildTaskDispatchedEvent,
  buildTaskCompletedEvent,
  buildTurnCompletedEvent,
  buildSubagentStartEvent,
  buildSubagentStopEvent,
  buildTeammateIdleEvent,
  buildTaskStatusCompletedEvent,
} from "../map-events.mjs";
import {
  makeHookData,
  makeSubagentStartData,
  makeSubagentStopData,
  makeTeammateIdleData,
  makeTaskCompletedData,
} from "./helpers.mjs";

describe("map-events", () => {
  describe("buildSpawnEvent", () => {
    it("builds event with type 'swarm.agent.spawned'", () => {
      const e = buildSpawnEvent("agent-1", "executor", "gsd", makeHookData());
      expect(e.type).toBe("swarm.agent.spawned");
    });

    it("sets agent name from parameter", () => {
      const e = buildSpawnEvent("my-agent", null, "t", makeHookData());
      expect(e.agent).toBe("my-agent");
    });

    it("sets role to matchedRole when provided", () => {
      const e = buildSpawnEvent("a", "executor", "t", makeHookData());
      expect(e.role).toBe("executor");
    });

    it("sets role to 'internal' when matchedRole is null", () => {
      const e = buildSpawnEvent("a", null, "t", makeHookData());
      expect(e.role).toBe("internal");
    });

    it("sets isTeamRole to true when matchedRole is truthy", () => {
      const e = buildSpawnEvent("a", "executor", "t", makeHookData());
      expect(e.isTeamRole).toBe(true);
    });

    it("sets isTeamRole to false when matchedRole is null", () => {
      const e = buildSpawnEvent("a", null, "t", makeHookData());
      expect(e.isTeamRole).toBe(false);
    });

    it("truncates task to 300 characters", () => {
      const longPrompt = "x".repeat(500);
      const e = buildSpawnEvent("a", null, "t", makeHookData({ prompt: longPrompt }));
      expect(e.task.length).toBe(300);
    });

    it("sets parent to teamName-sidecar", () => {
      const e = buildSpawnEvent("a", null, "my-team", makeHookData());
      expect(e.parent).toBe("my-team-sidecar");
    });

    it("uses tool_input.prompt first for task", () => {
      const e = buildSpawnEvent("a", null, "t", makeHookData({ prompt: "do X" }));
      expect(e.task).toBe("do X");
    });
  });

  describe("buildCompletedEvent", () => {
    it("builds event with type 'swarm.agent.completed'", () => {
      const e = buildCompletedEvent("a", "executor", "t");
      expect(e.type).toBe("swarm.agent.completed");
    });

    it("sets status to 'completed'", () => {
      const e = buildCompletedEvent("a", null, "t");
      expect(e.status).toBe("completed");
    });

    it("sets role from matchedRole or 'internal'", () => {
      expect(buildCompletedEvent("a", "exec", "t").role).toBe("exec");
      expect(buildCompletedEvent("a", null, "t").role).toBe("internal");
    });

    it("sets parent to teamName-sidecar", () => {
      const e = buildCompletedEvent("a", null, "gsd");
      expect(e.parent).toBe("gsd-sidecar");
    });
  });

  describe("buildTaskDispatchedEvent", () => {
    it("builds event with type 'swarm.task.dispatched'", () => {
      const e = buildTaskDispatchedEvent(makeHookData(), "t", null, "agent");
      expect(e.type).toBe("swarm.task.dispatched");
    });

    it("sets taskId from hook data", () => {
      const e = buildTaskDispatchedEvent(makeHookData({ toolUseId: "xyz" }), "t", null, "a");
      expect(e.taskId).toBe("xyz");
    });

    it("sets agent to teamName-sidecar", () => {
      const e = buildTaskDispatchedEvent(makeHookData(), "my-team", null, "a");
      expect(e.agent).toBe("my-team-sidecar");
    });

    it("sets targetAgent to teamName-role when matched", () => {
      const e = buildTaskDispatchedEvent(makeHookData(), "gsd", "executor", "a");
      expect(e.targetAgent).toBe("gsd-executor");
    });

    it("sets targetAgent to agentName when no match", () => {
      const e = buildTaskDispatchedEvent(makeHookData(), "gsd", null, "my-agent");
      expect(e.targetAgent).toBe("my-agent");
    });

    it("truncates description to 300 characters", () => {
      const long = "y".repeat(500);
      const e = buildTaskDispatchedEvent(makeHookData({ prompt: long }), "t", null, "a");
      expect(e.description.length).toBe(300);
    });
  });

  describe("buildTaskCompletedEvent", () => {
    it("builds event with type 'swarm.task.completed'", () => {
      const e = buildTaskCompletedEvent(makeHookData(), "t", null, "a");
      expect(e.type).toBe("swarm.task.completed");
    });

    it("sets agent to teamName-role when matched", () => {
      const e = buildTaskCompletedEvent(makeHookData(), "gsd", "exec", "a");
      expect(e.agent).toBe("gsd-exec");
    });

    it("sets agent to agentName when no match", () => {
      const e = buildTaskCompletedEvent(makeHookData(), "gsd", null, "my-agent");
      expect(e.agent).toBe("my-agent");
    });

    it("sets parent to teamName-sidecar", () => {
      const e = buildTaskCompletedEvent(makeHookData(), "gsd", null, "a");
      expect(e.parent).toBe("gsd-sidecar");
    });
  });

  describe("buildTurnCompletedEvent", () => {
    it("builds event with type 'swarm.turn.completed'", () => {
      const e = buildTurnCompletedEvent("gsd", makeHookData());
      expect(e.type).toBe("swarm.turn.completed");
    });

    it("sets agent to teamName-sidecar", () => {
      const e = buildTurnCompletedEvent("gsd", makeHookData());
      expect(e.agent).toBe("gsd-sidecar");
    });

    it("uses hookData.stop_reason", () => {
      const e = buildTurnCompletedEvent("gsd", makeHookData({ stopReason: "max_tokens" }));
      expect(e.stopReason).toBe("max_tokens");
    });

    it("defaults to 'end_turn'", () => {
      const e = buildTurnCompletedEvent("gsd", { stop_reason: undefined });
      expect(e.stopReason).toBe("end_turn");
    });
  });

  describe("buildSubagentStartEvent", () => {
    it("builds event with type 'swarm.subagent.started'", () => {
      const e = buildSubagentStartEvent(makeSubagentStartData(), "gsd");
      expect(e.type).toBe("swarm.subagent.started");
    });

    it("sets agentId from hookData", () => {
      const e = buildSubagentStartEvent(makeSubagentStartData({ agentId: "agent-xyz" }), "gsd");
      expect(e.agentId).toBe("agent-xyz");
    });

    it("sets agentType from hookData", () => {
      const e = buildSubagentStartEvent(makeSubagentStartData({ agentType: "Plan" }), "gsd");
      expect(e.agentType).toBe("Plan");
    });

    it("sets parent to teamName-sidecar", () => {
      const e = buildSubagentStartEvent(makeSubagentStartData(), "my-team");
      expect(e.parent).toBe("my-team-sidecar");
    });

    it("sets sessionId from hookData", () => {
      const e = buildSubagentStartEvent(makeSubagentStartData({ sessionId: "sess-1" }), "t");
      expect(e.sessionId).toBe("sess-1");
    });

    it("handles missing fields gracefully", () => {
      const e = buildSubagentStartEvent({}, "t");
      expect(e.agentId).toBe("");
      expect(e.agentType).toBe("");
      expect(e.sessionId).toBe("");
    });
  });

  describe("buildSubagentStopEvent", () => {
    it("builds event with type 'swarm.subagent.stopped'", () => {
      const e = buildSubagentStopEvent(makeSubagentStopData(), "gsd");
      expect(e.type).toBe("swarm.subagent.stopped");
    });

    it("sets agentId from hookData", () => {
      const e = buildSubagentStopEvent(makeSubagentStopData({ agentId: "agent-xyz" }), "gsd");
      expect(e.agentId).toBe("agent-xyz");
    });

    it("sets agentType from hookData", () => {
      const e = buildSubagentStopEvent(makeSubagentStopData({ agentType: "Bash" }), "gsd");
      expect(e.agentType).toBe("Bash");
    });

    it("sets parent to teamName-sidecar", () => {
      const e = buildSubagentStopEvent(makeSubagentStopData(), "my-team");
      expect(e.parent).toBe("my-team-sidecar");
    });

    it("includes lastMessage from hookData", () => {
      const e = buildSubagentStopEvent(makeSubagentStopData({ lastAssistantMessage: "Done!" }), "t");
      expect(e.lastMessage).toBe("Done!");
    });

    it("truncates lastMessage to 500 characters", () => {
      const longMsg = "x".repeat(800);
      const e = buildSubagentStopEvent(makeSubagentStopData({ lastAssistantMessage: longMsg }), "t");
      expect(e.lastMessage.length).toBe(500);
    });

    it("handles missing fields gracefully", () => {
      const e = buildSubagentStopEvent({}, "t");
      expect(e.agentId).toBe("");
      expect(e.agentType).toBe("");
      expect(e.lastMessage).toBe("");
    });
  });

  describe("buildTeammateIdleEvent", () => {
    it("builds event with type 'swarm.teammate.idle'", () => {
      const e = buildTeammateIdleEvent(makeTeammateIdleData(), "gsd", "researcher");
      expect(e.type).toBe("swarm.teammate.idle");
    });

    it("sets teammateName from hookData", () => {
      const e = buildTeammateIdleEvent(makeTeammateIdleData({ teammateName: "executor" }), "t", "executor");
      expect(e.teammateName).toBe("executor");
    });

    it("sets teamName from hookData", () => {
      const e = buildTeammateIdleEvent(makeTeammateIdleData({ teamName: "gsd-team" }), "t", null);
      expect(e.teamName).toBe("gsd-team");
    });

    it("falls back to config teamName when hookData has no team_name", () => {
      const e = buildTeammateIdleEvent({ teammate_name: "a" }, "fallback-team", null);
      expect(e.teamName).toBe("fallback-team");
    });

    it("sets role from matchedRole", () => {
      const e = buildTeammateIdleEvent(makeTeammateIdleData(), "t", "researcher");
      expect(e.role).toBe("researcher");
      expect(e.isTeamRole).toBe(true);
    });

    it("sets role to 'unknown' when no match", () => {
      const e = buildTeammateIdleEvent(makeTeammateIdleData(), "t", null);
      expect(e.role).toBe("unknown");
      expect(e.isTeamRole).toBe(false);
    });
  });

  describe("buildTaskStatusCompletedEvent", () => {
    it("builds event with type 'swarm.task.status_completed'", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData(), "gsd", null);
      expect(e.type).toBe("swarm.task.status_completed");
    });

    it("sets taskId from hookData", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData({ taskId: "t-99" }), "t", null);
      expect(e.taskId).toBe("t-99");
    });

    it("sets taskSubject from hookData", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData({ taskSubject: "Fix bug" }), "t", null);
      expect(e.taskSubject).toBe("Fix bug");
    });

    it("truncates taskDescription to 300 characters", () => {
      const longDesc = "d".repeat(500);
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData({ taskDescription: longDesc }), "t", null);
      expect(e.taskDescription.length).toBe(300);
    });

    it("sets teammateName from hookData", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData({ teammateName: "builder" }), "t", "builder");
      expect(e.teammateName).toBe("builder");
    });

    it("sets teamName from hookData", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData({ teamName: "gsd" }), "t", null);
      expect(e.teamName).toBe("gsd");
    });

    it("falls back to config teamName", () => {
      const e = buildTaskStatusCompletedEvent({ task_id: "1" }, "fallback", null);
      expect(e.teamName).toBe("fallback");
    });

    it("sets role from matchedRole", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData(), "t", "implementer");
      expect(e.role).toBe("implementer");
      expect(e.isTeamRole).toBe(true);
    });

    it("sets role to 'unknown' when no match", () => {
      const e = buildTaskStatusCompletedEvent(makeTaskCompletedData(), "t", null);
      expect(e.role).toBe("unknown");
      expect(e.isTeamRole).toBe(false);
    });
  });
});
