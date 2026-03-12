import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAgentId,
  buildSpawnCommand,
  buildDoneCommand,
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  buildTaskSyncPayload,
  buildOpentasksBridgeCommands,
  handleTaskCreated,
  handleTaskCompleted,
  handleTaskStatusCompleted,
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

  describe("buildAgentId", () => {
    it("uses tool_use_id/role format", () => {
      const id = buildAgentId("agent-1", "executor", makeHookData());
      expect(id).toBe("tool-123/executor");
    });

    it("falls back to agentName when no role matched", () => {
      const id = buildAgentId("my-agent", null, makeHookData());
      expect(id).toBe("tool-123/my-agent");
    });

    it("uses session_id when no tool_use_id", () => {
      const id = buildAgentId("a", "exec", { session_id: "sess-1" });
      expect(id).toBe("sess-1/exec");
    });
  });

  describe("buildSpawnCommand", () => {
    it("returns action 'spawn'", () => {
      const cmd = buildSpawnCommand("agent-1", "executor", "gsd", makeHookData());
      expect(cmd.action).toBe("spawn");
    });

    it("sets agentId to tool_use_id/role format when matched", () => {
      const cmd = buildSpawnCommand("agent-1", "executor", "gsd", makeHookData());
      expect(cmd.agent.agentId).toBe("tool-123/executor");
    });

    it("sets agentId to tool_use_id/agentName when no role match", () => {
      const cmd = buildSpawnCommand("my-agent", null, "gsd", makeHookData());
      expect(cmd.agent.agentId).toBe("tool-123/my-agent");
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

    it("uses session_id for scopes when available", () => {
      const hookData = { ...makeHookData(), session_id: "sess-abc" };
      const cmd = buildSpawnCommand("a", null, "my-team", hookData);
      expect(cmd.agent.scopes).toEqual(["sess-abc"]);
    });

    it("falls back to swarm:teamName for scopes when no session_id", () => {
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

    it("sets metadata.toolUseId from hookData", () => {
      const cmd = buildSpawnCommand("a", null, "t", makeHookData({ toolUseId: "tu-xyz" }));
      expect(cmd.agent.metadata.toolUseId).toBe("tu-xyz");
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
      const cmd = buildDoneCommand("a", "executor", "t", makeHookData());
      expect(cmd.action).toBe("done");
    });

    it("sets agentId to tool_use_id/role format when matched", () => {
      const cmd = buildDoneCommand("a", "executor", "gsd", makeHookData());
      expect(cmd.agentId).toBe("tool-123/executor");
    });

    it("sets agentId to tool_use_id/agentName when no match", () => {
      const cmd = buildDoneCommand("my-agent", null, "gsd", makeHookData());
      expect(cmd.agentId).toBe("tool-123/my-agent");
    });

    it("sets reason to 'completed'", () => {
      const cmd = buildDoneCommand("a", null, "t", makeHookData());
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

  // ── Task lifecycle handlers (opentasks daemon + MAP event bridge) ─────────
  //
  // These test the full two-step flow:
  // 1. Task CRUD in opentasks daemon (via mocked opentasks-client)
  // 2. Bridge event emission to MAP (via mocked sidecar-client capturing commands)

  describe("handleTaskCreated", () => {
    let mockCreateTask;
    let mockFindSocketPath;
    let sidecarCommands;

    beforeEach(async () => {
      mockCreateTask = vi.fn().mockResolvedValue({ id: "created-task-1" });
      mockFindSocketPath = vi.fn().mockReturnValue("/tmp/test.sock");
      sidecarCommands = [];

      // Mock opentasks-client (dynamic import target)
      vi.doMock("../opentasks-client.mjs", () => ({
        createTask: mockCreateTask,
        findSocketPath: mockFindSocketPath,
      }));

      // Mock sidecar-client to capture commands sent via sendCommand
      vi.doMock("../sidecar-client.mjs", () => ({
        sendToSidecar: vi.fn(async (cmd) => {
          sidecarCommands.push(cmd);
          return true;
        }),
        ensureSidecar: vi.fn().mockResolvedValue(false),
      }));

      // Mock paths to avoid filesystem access
      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath: "/tmp/sidecar.sock",
          inboxSocketPath: "/tmp/inbox.sock",
        })),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("creates task in opentasks with correct params", async () => {
      const { handleTaskCreated } = await import("../map-events.mjs");
      const hookData = makeHookData({ prompt: "Fix the bug" });
      const config = { map: { enabled: true } };

      await handleTaskCreated(config, hookData, "gsd", "executor", "test-agent", null);

      expect(mockCreateTask).toHaveBeenCalledWith("/tmp/test.sock", expect.objectContaining({
        title: "Fix the bug",
        status: "open",
        content: "Fix the bug",
        assignee: "gsd-executor",
        metadata: expect.objectContaining({
          source: "claude-code-swarm",
          teamName: "gsd",
          role: "executor",
        }),
      }));
    });

    it("emits bridge-task-created command with task data", async () => {
      const { handleTaskCreated } = await import("../map-events.mjs");
      const hookData = makeHookData({ prompt: "Fix the bug" });
      const config = { map: { enabled: true } };

      await handleTaskCreated(config, hookData, "gsd", "executor", "test-agent", "sess-1");

      const createdCmd = sidecarCommands.find((c) => c.action === "bridge-task-created");
      expect(createdCmd).toBeDefined();
      expect(createdCmd.task.id).toBe("created-task-1");
      expect(createdCmd.task.title).toBe("Fix the bug");
      expect(createdCmd.task.status).toBe("open");
      expect(createdCmd.task.assignee).toBe("gsd-executor");
      expect(createdCmd.agentId).toBe("gsd-executor");
    });

    it("emits bridge-task-assigned command when assignee exists", async () => {
      const { handleTaskCreated } = await import("../map-events.mjs");
      const hookData = makeHookData({ prompt: "Do X" });
      const config = { map: { enabled: true } };

      await handleTaskCreated(config, hookData, "gsd", "executor", "test-agent", null);

      const assignedCmd = sidecarCommands.find((c) => c.action === "bridge-task-assigned");
      expect(assignedCmd).toBeDefined();
      expect(assignedCmd.taskId).toBe("created-task-1");
      expect(assignedCmd.assignee).toBe("gsd-executor");
    });

    it("uses agentName as assignee when no role matched", async () => {
      const { handleTaskCreated } = await import("../map-events.mjs");
      const hookData = makeHookData();
      const config = { map: { enabled: true } };

      await handleTaskCreated(config, hookData, "gsd", null, "my-agent", null);

      expect(mockCreateTask).toHaveBeenCalledWith("/tmp/test.sock", expect.objectContaining({
        assignee: "my-agent",
      }));
    });

    it("falls back to tool_use_id for taskId when createTask returns null", async () => {
      mockCreateTask.mockResolvedValue(null);
      const { handleTaskCreated } = await import("../map-events.mjs");
      const hookData = makeHookData({ toolUseId: "tu-fallback" });
      const config = { map: { enabled: true } };

      await handleTaskCreated(config, hookData, "gsd", null, "agent", null);

      const createdCmd = sidecarCommands.find((c) => c.action === "bridge-task-created");
      expect(createdCmd.task.id).toBe("tu-fallback");
    });
  });

  describe("handleTaskCompleted", () => {
    let mockUpdateTask;
    let mockFindSocketPath;
    let sidecarCommands;

    beforeEach(() => {
      mockUpdateTask = vi.fn().mockResolvedValue({ id: "task-1" });
      mockFindSocketPath = vi.fn().mockReturnValue("/tmp/test.sock");
      sidecarCommands = [];

      vi.doMock("../opentasks-client.mjs", () => ({
        updateTask: mockUpdateTask,
        findSocketPath: mockFindSocketPath,
      }));

      vi.doMock("../sidecar-client.mjs", () => ({
        sendToSidecar: vi.fn(async (cmd) => {
          sidecarCommands.push(cmd);
          return true;
        }),
        ensureSidecar: vi.fn().mockResolvedValue(false),
      }));

      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath: "/tmp/sidecar.sock",
          inboxSocketPath: "/tmp/inbox.sock",
        })),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("updates task to closed status in opentasks", async () => {
      const { handleTaskCompleted } = await import("../map-events.mjs");
      const hookData = makeHookData({ toolUseId: "task-42" });
      const config = { map: { enabled: true } };

      await handleTaskCompleted(config, hookData, "gsd", "executor", "test-agent", null);

      expect(mockUpdateTask).toHaveBeenCalledWith("/tmp/test.sock", "task-42", expect.objectContaining({
        status: "closed",
        metadata: expect.objectContaining({
          completedBy: "gsd-executor",
          source: "claude-code-swarm",
        }),
      }));
    });

    it("emits bridge-task-status with completed status", async () => {
      const { handleTaskCompleted } = await import("../map-events.mjs");
      const hookData = makeHookData({ toolUseId: "task-42" });
      const config = { map: { enabled: true } };

      await handleTaskCompleted(config, hookData, "gsd", "executor", "test-agent", "sess-2");

      const statusCmd = sidecarCommands.find((c) => c.action === "bridge-task-status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd.taskId).toBe("task-42");
      expect(statusCmd.previous).toBe("open");
      expect(statusCmd.current).toBe("completed");
      expect(statusCmd.agentId).toBe("gsd-executor");
    });

    it("skips opentasks update when no taskId", async () => {
      const { handleTaskCompleted } = await import("../map-events.mjs");
      const hookData = { tool_input: {} }; // no tool_use_id
      const config = { map: { enabled: true } };

      await handleTaskCompleted(config, hookData, "gsd", null, "agent", null);

      expect(mockUpdateTask).not.toHaveBeenCalled();
    });

    it("still emits bridge event even when no taskId", async () => {
      const { handleTaskCompleted } = await import("../map-events.mjs");
      const hookData = { tool_input: {} };
      const config = { map: { enabled: true } };

      await handleTaskCompleted(config, hookData, "gsd", null, "agent", null);

      const statusCmd = sidecarCommands.find((c) => c.action === "bridge-task-status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd.current).toBe("completed");
    });
  });

  describe("handleTaskStatusCompleted", () => {
    let mockUpdateTask;
    let mockFindSocketPath;
    let sidecarCommands;

    beforeEach(() => {
      mockUpdateTask = vi.fn().mockResolvedValue({ id: "task-1" });
      mockFindSocketPath = vi.fn().mockReturnValue("/tmp/test.sock");
      sidecarCommands = [];

      vi.doMock("../opentasks-client.mjs", () => ({
        updateTask: mockUpdateTask,
        findSocketPath: mockFindSocketPath,
      }));

      vi.doMock("../sidecar-client.mjs", () => ({
        sendToSidecar: vi.fn(async (cmd) => {
          sidecarCommands.push(cmd);
          return true;
        }),
        ensureSidecar: vi.fn().mockResolvedValue(false),
      }));

      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath: "/tmp/sidecar.sock",
          inboxSocketPath: "/tmp/inbox.sock",
        })),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("updates task with richer metadata from TaskCompleted hook", async () => {
      const { handleTaskStatusCompleted } = await import("../map-events.mjs");
      const hookData = makeTaskCompletedData({
        taskId: "task-99",
        taskSubject: "Fix bug",
        teammateName: "builder",
        teamName: "gsd",
      });
      const config = { map: { enabled: true } };

      await handleTaskStatusCompleted(config, hookData, "gsd", "builder", null);

      expect(mockUpdateTask).toHaveBeenCalledWith("/tmp/test.sock", "task-99", expect.objectContaining({
        status: "closed",
        title: "Fix bug",
        metadata: expect.objectContaining({
          completedBy: "builder",
          teamName: "gsd",
          role: "builder",
          isTeamRole: true,
          source: "claude-code-swarm",
        }),
      }));
    });

    it("emits bridge-task-status with in_progress → completed", async () => {
      const { handleTaskStatusCompleted } = await import("../map-events.mjs");
      const hookData = makeTaskCompletedData({ taskId: "task-99", teammateName: "builder" });
      const config = { map: { enabled: true } };

      await handleTaskStatusCompleted(config, hookData, "gsd", "builder", "sess-3");

      const statusCmd = sidecarCommands.find((c) => c.action === "bridge-task-status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd.taskId).toBe("task-99");
      expect(statusCmd.previous).toBe("in_progress");
      expect(statusCmd.current).toBe("completed");
      expect(statusCmd.agentId).toBe("builder");
    });

    it("skips opentasks update when no taskId", async () => {
      const { handleTaskStatusCompleted } = await import("../map-events.mjs");
      const hookData = { teammate_name: "builder" }; // no task_id
      const config = { map: { enabled: true } };

      await handleTaskStatusCompleted(config, hookData, "gsd", "builder", null);

      expect(mockUpdateTask).not.toHaveBeenCalled();
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

    it("maps status completed to completed", () => {
      const p = buildTaskSyncPayload({ tool_input: { status: "completed" } }, "t");
      expect(p.status).toBe("completed");
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

  describe("buildOpentasksBridgeCommands", () => {
    // ── create_task ──────────────────────────────────────────────────────

    it("create_task returns bridge-task-created + bridge-task-assigned", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__create_task",
        tool_input: { title: "Fix bug", assignee: "worker-1" },
        tool_output: JSON.stringify({ content: [{ text: JSON.stringify({ id: "task-42", title: "Fix bug", status: "open", assignee: "worker-1" }) }] }),
      });
      expect(cmds).toHaveLength(2);
      expect(cmds[0].action).toBe("bridge-task-created");
      expect(cmds[0].task.id).toBe("task-42");
      expect(cmds[0].task.title).toBe("Fix bug");
      expect(cmds[0].task.assignee).toBe("worker-1");
      expect(cmds[0].agentId).toBe("worker-1");
      expect(cmds[1].action).toBe("bridge-task-assigned");
      expect(cmds[1].taskId).toBe("task-42");
      expect(cmds[1].assignee).toBe("worker-1");
    });

    it("create_task uses input fields when tool_output is missing", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__create_task",
        tool_input: { title: "New task", status: "open" },
      });
      expect(cmds).toHaveLength(1); // no assignee → no assigned command
      expect(cmds[0].action).toBe("bridge-task-created");
      expect(cmds[0].task.title).toBe("New task");
      expect(cmds[0].task.id).toBe("");
      expect(cmds[0].agentId).toBe("opentasks"); // default when no assignee
    });

    it("create_task returns empty when no id and no title", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__create_task",
        tool_input: {},
      });
      expect(cmds).toHaveLength(0);
    });

    it("create_task parses already-parsed tool_output", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__create_task",
        tool_input: {},
        tool_output: { id: "direct-1", title: "Direct", status: "open" },
      });
      expect(cmds[0].task.id).toBe("direct-1");
    });

    // ── update_task ──────────────────────────────────────────────────────

    it("update_task returns bridge-task-status", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__update_task",
        tool_input: { id: "task-1", status: "completed" },
        tool_output: JSON.stringify({ content: [{ text: JSON.stringify({ id: "task-1", status: "completed", assignee: "builder" }) }] }),
      });
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("bridge-task-status");
      expect(cmds[0].taskId).toBe("task-1");
      expect(cmds[0].current).toBe("completed");
      expect(cmds[0].agentId).toBe("builder");
    });

    it("update_task uses input.transition as status fallback", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__update_task",
        tool_input: { id: "task-2", transition: "close" },
      });
      expect(cmds[0].current).toBe("close");
    });

    it("update_task returns empty when no id", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__update_task",
        tool_input: { status: "completed" },
      });
      expect(cmds).toHaveLength(0);
    });

    it("update_task returns empty when no status change", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__update_task",
        tool_input: { id: "task-3", title: "Renamed" }, // no status/transition
      });
      expect(cmds).toHaveLength(0);
    });

    it("update_task sets previous to undefined when explicit status in input", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__update_task",
        tool_input: { id: "task-1", status: "in_progress" },
      });
      expect(cmds[0].previous).toBeUndefined();
    });

    // ── link ──────────────────────────────────────────────────────────────

    it("link returns emit command with task.linked payload", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__link",
        tool_input: { fromId: "task-a", toId: "task-b", type: "blocks" },
      });
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("emit");
      expect(cmds[0].event.type).toBe("task.linked");
      expect(cmds[0].event.from).toBe("task-a");
      expect(cmds[0].event.to).toBe("task-b");
      expect(cmds[0].event.linkType).toBe("blocks");
      expect(cmds[0].event.source).toBe("opentasks");
    });

    it("link defaults linkType to related and remove to false", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__link",
        tool_input: { fromId: "a", toId: "b" },
      });
      expect(cmds[0].event.linkType).toBe("related");
      expect(cmds[0].event.remove).toBe(false);
    });

    it("link returns empty when fromId or toId is missing", () => {
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__link",
        tool_input: { fromId: "a" },
      })).toHaveLength(0);
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__link",
        tool_input: { toId: "b" },
      })).toHaveLength(0);
    });

    // ── annotate ──────────────────────────────────────────────────────────

    it("annotate returns emit command with task.sync payload", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__annotate",
        tool_input: { target: "task://1", feedback: { type: "suggestion" } },
      });
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("emit");
      expect(cmds[0].event.type).toBe("task.sync");
      expect(cmds[0].event.uri).toBe("task://1");
      expect(cmds[0].event.annotation).toBe("suggestion");
      expect(cmds[0].event.source).toBe("opentasks");
    });

    it("annotate defaults annotation to comment", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__annotate",
        tool_input: { target: "task://1" },
      });
      expect(cmds[0].event.annotation).toBe("comment");
    });

    it("annotate returns empty when target is missing", () => {
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__annotate",
        tool_input: {},
      })).toHaveLength(0);
    });

    // ── read-only tools ──────────────────────────────────────────────────

    it("query tool returns empty array (read-only)", () => {
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__query",
        tool_input: { filter: "status:open" },
      })).toHaveLength(0);
    });

    it("list_tasks returns empty array (read-only)", () => {
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__list_tasks",
        tool_input: {},
      })).toHaveLength(0);
    });

    it("get_task returns empty array (read-only)", () => {
      expect(buildOpentasksBridgeCommands({
        tool_name: "mcp__opentasks__get_task",
        tool_input: { id: "task-1" },
      })).toHaveLength(0);
    });

    // ── edge cases ───────────────────────────────────────────────────────

    it("returns empty array when hook data is empty", () => {
      expect(buildOpentasksBridgeCommands({})).toHaveLength(0);
    });

    it("handles plugin-namespaced tool names", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "mcp__plugin_claude-code-swarm_opentasks__create_task",
        tool_input: { title: "Namespaced" },
      });
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("bridge-task-created");
    });
  });
});
