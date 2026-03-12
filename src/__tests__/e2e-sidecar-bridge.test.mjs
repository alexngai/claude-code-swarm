/**
 * E2E tests: Real sidecar server → mock MAP connection → MAP events
 *
 * Tests the full pipeline:
 *   Hook data → buildOpentasksBridgeCommands → sendToSidecar (real socket) →
 *   sidecar command handler → mock MAP conn.send() → verify MAP event payloads
 *
 * Uses real UNIX socket server (no mocking of socket layer).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockMapConnection() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ agentId: "spawned-1" }),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    callExtension: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Send a JSON command over a UNIX socket and read the response.
 */
function sendSocketCommand(socketPath, command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let data = "";
    client.on("connect", () => {
      client.write(JSON.stringify(command) + "\n");
    });
    client.on("data", (chunk) => {
      data += chunk.toString();
      // Try to parse – response is a single JSON line
      try {
        const parsed = JSON.parse(data.trim().split("\n").pop());
        client.destroy();
        resolve(parsed);
      } catch {
        // wait for more data
      }
    });
    client.on("error", reject);
    // Timeout safety
    setTimeout(() => {
      client.destroy();
      try { resolve(JSON.parse(data.trim().split("\n").pop())); }
      catch { reject(new Error("Timeout waiting for response")); }
    }, 2000);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: sidecar socket server → MAP bridge events", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let registeredAgents;
  let handler;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-sidecar-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    registeredAgents = new Map();
    handler = createCommandHandler(mockConn, "swarm:e2e-test", registeredAgents);
    server = createSocketServer(socketPath, handler);
    await new Promise((resolve) => server.on("listening", resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    cleanupTmpDir(tmpDir);
  });

  // ==========================================================================
  // Task bridge events via real socket
  // ==========================================================================

  describe("bridge-task-created via socket", () => {
    it("sends task.created MAP event when bridge-task-created arrives over socket", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: { id: "task-e2e-1", title: "E2E test task", status: "open", assignee: "gsd-executor" },
        agentId: "gsd-executor",
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(1);

      const [target, payload, meta] = mockConn.send.mock.calls[0];
      expect(target).toEqual({ scope: "swarm:e2e-test" });
      expect(payload.type).toBe("task.created");
      expect(payload.task.id).toBe("task-e2e-1");
      expect(payload.task.title).toBe("E2E test task");
      expect(payload.task.assignee).toBe("gsd-executor");
      expect(payload._origin).toBe("gsd-executor");
      expect(meta.relationship).toBe("broadcast");
    });
  });

  describe("bridge-task-status via socket", () => {
    it("sends task.status MAP event for non-terminal status", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "task-e2e-2",
        previous: "open",
        current: "in_progress",
        agentId: "gsd-worker",
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(1);

      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.type).toBe("task.status");
      expect(payload.taskId).toBe("task-e2e-2");
      expect(payload.previous).toBe("open");
      expect(payload.current).toBe("in_progress");
    });

    it("sends both task.status and task.completed for terminal status 'completed'", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "task-e2e-3",
        previous: "in_progress",
        current: "completed",
        agentId: "gsd-executor",
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(2);

      const [, statusPayload] = mockConn.send.mock.calls[0];
      expect(statusPayload.type).toBe("task.status");
      expect(statusPayload.current).toBe("completed");

      const [, completedPayload] = mockConn.send.mock.calls[1];
      expect(completedPayload.type).toBe("task.completed");
      expect(completedPayload.taskId).toBe("task-e2e-3");
    });
  });

  describe("bridge-task-assigned via socket", () => {
    it("sends task.assigned MAP event", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "task-e2e-4",
        assignee: "gsd-developer",
        agentId: "gsd-developer",
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(1);

      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.type).toBe("task.assigned");
      expect(payload.taskId).toBe("task-e2e-4");
      expect(payload.agentId).toBe("gsd-developer");
    });
  });

  // ==========================================================================
  // Full pipeline: opentasks MCP create_task → bridge commands → MAP events
  // ==========================================================================

  describe("full pipeline: opentasks MCP create_task → sidecar → MAP", () => {
    it("sends correct MAP events for a task create + assign flow", async () => {
      // Step 1: bridge-task-created
      const createResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "ot-task-100",
          title: "Refactor auth module",
          status: "open",
          assignee: "gsd-developer",
        },
        agentId: "gsd-developer",
      });
      expect(createResp.ok).toBe(true);

      // Step 2: bridge-task-assigned
      const assignResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "ot-task-100",
        assignee: "gsd-developer",
        agentId: "gsd-developer",
      });
      expect(assignResp.ok).toBe(true);

      // Verify MAP events
      expect(mockConn.send).toHaveBeenCalledTimes(2);

      // First call: task.created
      const [, createdPayload] = mockConn.send.mock.calls[0];
      expect(createdPayload.type).toBe("task.created");
      expect(createdPayload.task.id).toBe("ot-task-100");
      expect(createdPayload.task.title).toBe("Refactor auth module");

      // Second call: task.assigned
      const [, assignedPayload] = mockConn.send.mock.calls[1];
      expect(assignedPayload.type).toBe("task.assigned");
      expect(assignedPayload.taskId).toBe("ot-task-100");
      expect(assignedPayload.agentId).toBe("gsd-developer");
    });

    it("sends correct MAP events for task create → status update → complete", async () => {
      // Create
      await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: { id: "ot-lifecycle-1", title: "Full lifecycle task", status: "open", assignee: "worker" },
        agentId: "worker",
      });

      // Start working
      await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "ot-lifecycle-1",
        previous: "open",
        current: "in_progress",
        agentId: "worker",
      });

      // Complete
      await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "ot-lifecycle-1",
        previous: "in_progress",
        current: "completed",
        agentId: "worker",
      });

      // 4 calls: task.created, task.status(in_progress), task.status(completed), task.completed
      expect(mockConn.send).toHaveBeenCalledTimes(4);

      const types = mockConn.send.mock.calls.map(([, p]) => p.type);
      expect(types).toEqual([
        "task.created",
        "task.status",
        "task.status",
        "task.completed",
      ]);

      // Verify the task.completed payload
      const completedPayload = mockConn.send.mock.calls[3][1];
      expect(completedPayload.taskId).toBe("ot-lifecycle-1");
    });
  });

  // ==========================================================================
  // Full pipeline: native TaskCreate → bridge commands → MAP events
  // ==========================================================================

  describe("full pipeline: native TaskCreate hook → sidecar → MAP", () => {
    it("emits task.created and task.assigned for native TaskCreate with owner", async () => {
      // Simulate what map-hook.mjs handleNativeTaskCreated sends to sidecar
      const createResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "native-1",
          title: "Fix authentication bug",
          status: "open",
          assignee: "gsd-lead",
        },
        agentId: "gsd-lead",
      });
      expect(createResp.ok).toBe(true);

      const assignResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "native-1",
        assignee: "gsd-lead",
        agentId: "gsd-lead",
      });
      expect(assignResp.ok).toBe(true);

      expect(mockConn.send).toHaveBeenCalledTimes(2);

      const createdPayload = mockConn.send.mock.calls[0][1];
      expect(createdPayload.type).toBe("task.created");
      expect(createdPayload.task.id).toBe("native-1");
      expect(createdPayload.task.title).toBe("Fix authentication bug");

      const assignedPayload = mockConn.send.mock.calls[1][1];
      expect(assignedPayload.type).toBe("task.assigned");
      expect(assignedPayload.agentId).toBe("gsd-lead");
    });

    it("emits task.status for native TaskUpdate with status change", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "native-2",
        current: "in_progress",
        agentId: "gsd-executor",
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(1);

      const payload = mockConn.send.mock.calls[0][1];
      expect(payload.type).toBe("task.status");
      expect(payload.taskId).toBe("native-2");
      expect(payload.current).toBe("in_progress");
      expect(payload._origin).toBe("gsd-executor");
    });
  });

  // ==========================================================================
  // Agent lifecycle events via real socket
  // ==========================================================================

  describe("agent lifecycle via socket", () => {
    it("spawn → state update → done full lifecycle", async () => {
      // Spawn
      const spawnResp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "e2e-agent-1",
          name: "executor",
          role: "executor",
          scopes: ["swarm:e2e-test"],
          metadata: { template: "gsd" },
        },
      });
      expect(spawnResp.ok).toBe(true);
      expect(mockConn.spawn).toHaveBeenCalledWith({
        agentId: "e2e-agent-1",
        name: "executor",
        role: "executor",
        scopes: ["swarm:e2e-test"],
        metadata: { template: "gsd" },
      });

      // State update
      const stateResp = await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
        agentId: "e2e-agent-1",
      });
      expect(stateResp.ok).toBe(true);
      expect(registeredAgents.get("e2e-agent-1").lastState).toBe("busy");

      // Done
      const doneResp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "e2e-agent-1",
        reason: "completed",
      });
      expect(doneResp.ok).toBe(true);
      expect(mockConn.callExtension).toHaveBeenCalledWith(
        "map/agents/unregister",
        { agentId: "e2e-agent-1", reason: "completed" },
      );
      expect(registeredAgents.has("e2e-agent-1")).toBe(false);
    });
  });

  // ==========================================================================
  // Emit action via real socket
  // ==========================================================================

  describe("emit action via socket", () => {
    it("sends arbitrary event via MAP connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "task.sync", uri: "claude://team/1", status: "open" },
        meta: {},
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledWith(
        { scope: "swarm:e2e-test" },
        { type: "task.sync", uri: "claude://team/1", status: "open" },
        {},
      );
    });
  });

  // ==========================================================================
  // Mixed workflow: agent spawn + task create + task complete
  // ==========================================================================

  describe("mixed workflow: agent spawn → task create → task complete → agent done", () => {
    it("executes full swarm task lifecycle and emits all expected MAP events", async () => {
      // 1. Spawn agent
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "workflow-agent",
          name: "worker",
          role: "executor",
          scopes: ["swarm:e2e-test"],
          metadata: { template: "gsd" },
        },
      });

      // 2. Agent creates a task
      await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: { id: "workflow-task-1", title: "Build feature", status: "open", assignee: "workflow-agent" },
        agentId: "workflow-agent",
      });

      // 3. Agent assigns task
      await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "workflow-task-1",
        assignee: "workflow-agent",
        agentId: "workflow-agent",
      });

      // 4. Agent starts working
      await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "workflow-task-1",
        previous: "open",
        current: "in_progress",
        agentId: "workflow-agent",
      });

      // 5. Agent completes task
      await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "workflow-task-1",
        previous: "in_progress",
        current: "completed",
        agentId: "workflow-agent",
      });

      // 6. Agent done
      await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "workflow-agent",
        reason: "completed",
      });

      // Verify: spawn called, 5 MAP sends, callExtension for done
      expect(mockConn.spawn).toHaveBeenCalledTimes(1);
      expect(mockConn.callExtension).toHaveBeenCalledTimes(1);

      // MAP send calls: task.created, task.assigned, task.status(in_progress), task.status(completed), task.completed
      expect(mockConn.send).toHaveBeenCalledTimes(5);
      const types = mockConn.send.mock.calls.map(([, p]) => p.type);
      expect(types).toEqual([
        "task.created",
        "task.assigned",
        "task.status",
        "task.status",
        "task.completed",
      ]);
    });
  });

  // ==========================================================================
  // Ping health check
  // ==========================================================================

  describe("ping via socket", () => {
    it("responds with ok and pid", async () => {
      const resp = await sendSocketCommand(socketPath, { action: "ping" });
      expect(resp.ok).toBe(true);
      expect(resp.pid).toBe(process.pid);
    });
  });
});
