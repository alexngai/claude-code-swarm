import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSpawnEvent,
  buildCompletedEvent,
  buildTaskDispatchedEvent,
  buildTaskCompletedEvent,
  buildTurnCompletedEvent,
} from "../map-events.mjs";
import { makeHookData } from "./helpers.mjs";

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
});
