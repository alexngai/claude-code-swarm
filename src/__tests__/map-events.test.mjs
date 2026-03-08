import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSpawnCommand,
  buildDoneCommand,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  buildTaskDispatchedPayload,
  buildTaskCompletedPayload,
  buildTaskStatusPayload,
  buildTaskSyncPayload,
  buildOpentasksSyncPayload,
} from "../map-events.mjs";
import {
  makeHookData,
  makeSubagentStartData,
  makeSubagentStopData,
  makeTeammateIdleData,
  makeTaskCompletedData,
} from "./helpers.mjs";

describe("map-events", () => {
  // ── Agent lifecycle commands ──────────────────────────────────────────────

  describe("buildSpawnCommand", () => {
    it("returns action 'spawn'", () => {
      const cmd = buildSpawnCommand("agent-1", "executor", "gsd", makeHookData());
      expect(cmd.action).toBe("spawn");
    });

    it("sets agentId to teamName-role when matched", () => {
      const cmd = buildSpawnCommand("agent-1", "executor", "gsd", makeHookData());
      expect(cmd.agent.agentId).toBe("gsd-executor");
    });

    it("sets agentId to agentName when no role match", () => {
      const cmd = buildSpawnCommand("my-agent", null, "gsd", makeHookData());
      expect(cmd.agent.agentId).toBe("my-agent");
    });

    it("sets name to matchedRole when provided", () => {
      const cmd = buildSpawnCommand("a", "executor", "t", makeHookData());
      expect(cmd.agent.name).toBe("executor");
    });

    it("sets name to agentName when no match", () => {
      const cmd = buildSpawnCommand("my-agent", null, "t", makeHookData());
      expect(cmd.agent.name).toBe("my-agent");
    });

    it("sets role from matchedRole or 'internal'", () => {
      expect(buildSpawnCommand("a", "executor", "t", makeHookData()).agent.role).toBe("executor");
      expect(buildSpawnCommand("a", null, "t", makeHookData()).agent.role).toBe("internal");
    });

    it("sets scopes to swarm:teamName", () => {
      const cmd = buildSpawnCommand("a", null, "my-team", makeHookData());
      expect(cmd.agent.scopes).toEqual(["swarm:my-team"]);
    });

    it("sets metadata.isTeamRole based on matchedRole", () => {
      expect(buildSpawnCommand("a", "exec", "t", makeHookData()).agent.metadata.isTeamRole).toBe(true);
      expect(buildSpawnCommand("a", null, "t", makeHookData()).agent.metadata.isTeamRole).toBe(false);
    });

    it("sets metadata.template to teamName", () => {
      const cmd = buildSpawnCommand("a", null, "gsd", makeHookData());
      expect(cmd.agent.metadata.template).toBe("gsd");
    });

    it("truncates task in metadata to 300 characters", () => {
      const longPrompt = "x".repeat(500);
      const cmd = buildSpawnCommand("a", null, "t", makeHookData({ prompt: longPrompt }));
      expect(cmd.agent.metadata.task.length).toBe(300);
    });

    it("uses tool_input.prompt for task metadata", () => {
      const cmd = buildSpawnCommand("a", null, "t", makeHookData({ prompt: "do X" }));
      expect(cmd.agent.metadata.task).toBe("do X");
    });
  });

  describe("buildDoneCommand", () => {
    it("returns action 'done'", () => {
      const cmd = buildDoneCommand("a", "executor", "t");
      expect(cmd.action).toBe("done");
    });

    it("sets agentId to teamName-role when matched", () => {
      const cmd = buildDoneCommand("a", "executor", "gsd");
      expect(cmd.agentId).toBe("gsd-executor");
    });

    it("sets agentId to agentName when no match", () => {
      const cmd = buildDoneCommand("my-agent", null, "gsd");
      expect(cmd.agentId).toBe("my-agent");
    });

    it("sets reason to 'completed'", () => {
      const cmd = buildDoneCommand("a", null, "t");
      expect(cmd.reason).toBe("completed");
    });
  });

  describe("buildSubagentSpawnCommand", () => {
    it("returns action 'spawn'", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData(), "gsd");
      expect(cmd.action).toBe("spawn");
    });

    it("sets agentId from hookData.agent_id", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData({ agentId: "agent-xyz" }), "gsd");
      expect(cmd.agent.agentId).toBe("agent-xyz");
    });

    it("sets role to 'subagent'", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData(), "gsd");
      expect(cmd.agent.role).toBe("subagent");
    });

    it("sets name from agentType", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData({ agentType: "Plan" }), "gsd");
      expect(cmd.agent.name).toBe("Plan");
    });

    it("sets metadata.agentType from hookData", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData({ agentType: "Explore" }), "gsd");
      expect(cmd.agent.metadata.agentType).toBe("Explore");
    });

    it("sets metadata.sessionId from hookData", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData({ sessionId: "sess-1" }), "t");
      expect(cmd.agent.metadata.sessionId).toBe("sess-1");
    });

    it("sets metadata.isTeamRole to false", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData(), "t");
      expect(cmd.agent.metadata.isTeamRole).toBe(false);
    });

    it("sets scopes to swarm:teamName", () => {
      const cmd = buildSubagentSpawnCommand(makeSubagentStartData(), "my-team");
      expect(cmd.agent.scopes).toEqual(["swarm:my-team"]);
    });

    it("handles missing fields gracefully", () => {
      const cmd = buildSubagentSpawnCommand({}, "t");
      expect(cmd.agent.name).toBe("subagent");
      expect(cmd.agent.metadata.agentType).toBe("");
      expect(cmd.agent.metadata.sessionId).toBe("");
    });
  });

  describe("buildSubagentDoneCommand", () => {
    it("returns action 'done'", () => {
      const cmd = buildSubagentDoneCommand(makeSubagentStopData(), "gsd");
      expect(cmd.action).toBe("done");
    });

    it("sets agentId from hookData", () => {
      const cmd = buildSubagentDoneCommand(makeSubagentStopData({ agentId: "agent-xyz" }), "gsd");
      expect(cmd.agentId).toBe("agent-xyz");
    });

    it("uses lastAssistantMessage as reason", () => {
      const cmd = buildSubagentDoneCommand(makeSubagentStopData({ lastAssistantMessage: "Done!" }), "t");
      expect(cmd.reason).toBe("Done!");
    });

    it("truncates reason to 500 characters", () => {
      const longMsg = "x".repeat(800);
      const cmd = buildSubagentDoneCommand(makeSubagentStopData({ lastAssistantMessage: longMsg }), "t");
      expect(cmd.reason.length).toBe(500);
    });

    it("defaults reason to 'completed' when no message", () => {
      const cmd = buildSubagentDoneCommand({ agent_id: "a" }, "t");
      expect(cmd.reason).toBe("completed");
    });

    it("handles missing fields gracefully", () => {
      const cmd = buildSubagentDoneCommand({}, "t");
      expect(cmd.agentId).toBe("");
    });
  });

  // ── State update commands ─────────────────────────────────────────────────

  describe("buildStateCommand", () => {
    it("returns action 'state'", () => {
      const cmd = buildStateCommand(null, "idle");
      expect(cmd.action).toBe("state");
    });

    it("sets state", () => {
      const cmd = buildStateCommand(null, "busy");
      expect(cmd.state).toBe("busy");
    });

    it("includes agentId when provided", () => {
      const cmd = buildStateCommand("gsd-executor", "idle");
      expect(cmd.agentId).toBe("gsd-executor");
    });

    it("omits agentId when null", () => {
      const cmd = buildStateCommand(null, "idle");
      expect(cmd).not.toHaveProperty("agentId");
    });

    it("includes metadata when provided", () => {
      const cmd = buildStateCommand(null, "idle", { lastStopReason: "end_turn" });
      expect(cmd.metadata).toEqual({ lastStopReason: "end_turn" });
    });

    it("omits metadata when not provided", () => {
      const cmd = buildStateCommand(null, "idle");
      expect(cmd).not.toHaveProperty("metadata");
    });
  });

  // ── Task lifecycle payloads ───────────────────────────────────────────────

  describe("buildTaskDispatchedPayload", () => {
    it("sets type to 'task.dispatched'", () => {
      const p = buildTaskDispatchedPayload(makeHookData(), "t", null, "agent");
      expect(p.type).toBe("task.dispatched");
    });

    it("sets taskId from hook data", () => {
      const p = buildTaskDispatchedPayload(makeHookData({ toolUseId: "xyz" }), "t", null, "a");
      expect(p.taskId).toBe("xyz");
    });

    it("sets from to teamName-sidecar", () => {
      const p = buildTaskDispatchedPayload(makeHookData(), "my-team", null, "a");
      expect(p.from).toBe("my-team-sidecar");
    });

    it("sets targetAgent to teamName-role when matched", () => {
      const p = buildTaskDispatchedPayload(makeHookData(), "gsd", "executor", "a");
      expect(p.targetAgent).toBe("gsd-executor");
    });

    it("sets targetAgent to agentName when no match", () => {
      const p = buildTaskDispatchedPayload(makeHookData(), "gsd", null, "my-agent");
      expect(p.targetAgent).toBe("my-agent");
    });

    it("truncates description to 300 characters", () => {
      const long = "y".repeat(500);
      const p = buildTaskDispatchedPayload(makeHookData({ prompt: long }), "t", null, "a");
      expect(p.description.length).toBe(300);
    });
  });

  describe("buildTaskCompletedPayload", () => {
    it("sets type to 'task.completed'", () => {
      const p = buildTaskCompletedPayload(makeHookData(), "t", null, "a");
      expect(p.type).toBe("task.completed");
    });

    it("sets agent to teamName-role when matched", () => {
      const p = buildTaskCompletedPayload(makeHookData(), "gsd", "exec", "a");
      expect(p.agent).toBe("gsd-exec");
    });

    it("sets agent to agentName when no match", () => {
      const p = buildTaskCompletedPayload(makeHookData(), "gsd", null, "my-agent");
      expect(p.agent).toBe("my-agent");
    });

    it("sets status to 'completed'", () => {
      const p = buildTaskCompletedPayload(makeHookData(), "t", null, "a");
      expect(p.status).toBe("completed");
    });
  });

  describe("buildTaskStatusPayload", () => {
    it("sets type to 'task.completed'", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData(), "gsd", null);
      expect(p.type).toBe("task.completed");
    });

    it("sets taskId from hookData", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData({ taskId: "t-99" }), "t", null);
      expect(p.taskId).toBe("t-99");
    });

    it("sets taskSubject from hookData", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData({ taskSubject: "Fix bug" }), "t", null);
      expect(p.taskSubject).toBe("Fix bug");
    });

    it("truncates taskDescription to 300 characters", () => {
      const longDesc = "d".repeat(500);
      const p = buildTaskStatusPayload(makeTaskCompletedData({ taskDescription: longDesc }), "t", null);
      expect(p.taskDescription.length).toBe(300);
    });

    it("sets agent from hookData.teammate_name", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData({ teammateName: "builder" }), "t", "builder");
      expect(p.agent).toBe("builder");
    });

    it("sets teamName from hookData", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData({ teamName: "gsd" }), "t", null);
      expect(p.teamName).toBe("gsd");
    });

    it("falls back to config teamName", () => {
      const p = buildTaskStatusPayload({ task_id: "1" }, "fallback", null);
      expect(p.teamName).toBe("fallback");
    });

    it("sets role from matchedRole", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData(), "t", "implementer");
      expect(p.role).toBe("implementer");
      expect(p.isTeamRole).toBe(true);
    });

    it("sets role to 'unknown' when no match", () => {
      const p = buildTaskStatusPayload(makeTaskCompletedData(), "t", null);
      expect(p.role).toBe("unknown");
      expect(p.isTeamRole).toBe(false);
    });
  });

  // ── Task sync payloads (opentasks ↔ MAP bridge) ───────────────────────────

  describe("buildTaskSyncPayload", () => {
    it("sets type to 'task.sync'", () => {
      const p = buildTaskSyncPayload({ tool_input: { taskId: "t-1" } }, "gsd");
      expect(p.type).toBe("task.sync");
    });

    it("sets uri from tool_input.taskId", () => {
      const p = buildTaskSyncPayload({ tool_input: { taskId: "t-1" } }, "gsd");
      expect(p.uri).toBe("claude://gsd/t-1");
    });

    it("falls back to hookData.task_id for uri", () => {
      const p = buildTaskSyncPayload({ task_id: "t-2", tool_input: {} }, "gsd");
      expect(p.uri).toBe("claude://gsd/t-2");
    });

    it("maps status pending to open", () => {
      const p = buildTaskSyncPayload({ tool_input: { status: "pending" } }, "t");
      expect(p.status).toBe("open");
    });

    it("maps status completed to closed", () => {
      const p = buildTaskSyncPayload({ tool_input: { status: "completed" } }, "t");
      expect(p.status).toBe("closed");
    });

    it("maps status in_progress to in_progress", () => {
      const p = buildTaskSyncPayload({ tool_input: { status: "in_progress" } }, "t");
      expect(p.status).toBe("in_progress");
    });

    it("defaults status to open when not provided", () => {
      const p = buildTaskSyncPayload({ tool_input: {} }, "t");
      expect(p.status).toBe("open");
    });

    it("uses tool_input.subject for subject", () => {
      const p = buildTaskSyncPayload({ tool_input: { subject: "Fix bug" } }, "t");
      expect(p.subject).toBe("Fix bug");
    });

    it("falls back to task_subject from hookData", () => {
      const p = buildTaskSyncPayload({ task_subject: "Add feature", tool_input: {} }, "t");
      expect(p.subject).toBe("Add feature");
    });

    it("sets source to claude-code", () => {
      const p = buildTaskSyncPayload({ tool_input: {} }, "t");
      expect(p.source).toBe("claude-code");
    });
  });

  describe("buildOpentasksSyncPayload", () => {
    it("link tool returns task.linked payload", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__link",
        tool_input: { from: "task://a", to: "task://b", type: "blocks" },
      });
      expect(p.type).toBe("task.linked");
      expect(p.from).toBe("task://a");
      expect(p.to).toBe("task://b");
      expect(p.linkType).toBe("blocks");
      expect(p.source).toBe("opentasks");
    });

    it("link tool defaults linkType to related and remove to false", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__link",
        tool_input: { from: "a", to: "b" },
      });
      expect(p.linkType).toBe("related");
      expect(p.remove).toBe(false);
    });

    it("link tool returns null when from or to is missing", () => {
      expect(buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__link",
        tool_input: { from: "a" },
      })).toBeNull();
      expect(buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__link",
        tool_input: { to: "b" },
      })).toBeNull();
    });

    it("annotate tool returns task.sync with annotation", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__annotate",
        tool_input: { target: "task://1", feedback: { type: "suggestion" } },
      });
      expect(p.type).toBe("task.sync");
      expect(p.uri).toBe("task://1");
      expect(p.annotation).toBe("suggestion");
      expect(p.source).toBe("opentasks");
    });

    it("annotate tool defaults annotation to comment", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__annotate",
        tool_input: { target: "task://1" },
      });
      expect(p.annotation).toBe("comment");
    });

    it("annotate tool returns null when target is missing", () => {
      expect(buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__annotate",
        tool_input: {},
      })).toBeNull();
    });

    it("query tool returns null (read-only)", () => {
      expect(buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__query",
        tool_input: { filter: "status:open" },
      })).toBeNull();
    });

    it("generic fallback with input.target returns task.sync", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__update",
        tool_input: { target: "task://x", status: "closed" },
      });
      expect(p.type).toBe("task.sync");
      expect(p.uri).toBe("task://x");
      expect(p.status).toBe("closed");
      expect(p.source).toBe("opentasks");
    });

    it("generic fallback with input.id returns task.sync", () => {
      const p = buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__create",
        tool_input: { id: "task://y" },
      });
      expect(p.type).toBe("task.sync");
      expect(p.uri).toBe("task://y");
    });

    it("returns null when no syncable data present", () => {
      expect(buildOpentasksSyncPayload({
        tool_name: "mcp__opentasks__something",
        tool_input: {},
      })).toBeNull();
    });

    it("returns null when hook data is empty", () => {
      expect(buildOpentasksSyncPayload({})).toBeNull();
    });
  });
});
