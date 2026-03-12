/**
 * E2E tests: Native task hook handlers → real sidecar socket → MAP events
 *
 * Tests the full flow:
 *   handleNativeTaskCreatedEvent / handleNativeTaskUpdatedEvent →
 *   sendCommand() → sendToSidecar() (real UNIX socket) →
 *   sidecar command handler → mock MAP conn.send() → verify MAP events
 *
 * Closes gap 3: handler-to-socket E2E for native task hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { sendToSidecar } from "../sidecar-client.mjs";
import {
  handleNativeTaskCreatedEvent,
  handleNativeTaskUpdatedEvent,
  mapNativeTaskStatus,
} from "../map-events.mjs";
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: native task hook handlers → real sidecar → MAP events", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-native-hooks-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    registeredAgents = new Map();
    const handler = createCommandHandler(mockConn, "swarm:e2e", registeredAgents);
    server = createSocketServer(socketPath, handler);
    await new Promise((resolve) => server.on("listening", resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    cleanupTmpDir(tmpDir);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ==========================================================================
  // mapNativeTaskStatus
  // ==========================================================================

  describe("mapNativeTaskStatus", () => {
    it("maps pending to open", () => {
      expect(mapNativeTaskStatus("pending")).toBe("open");
    });

    it("maps in_progress to in_progress", () => {
      expect(mapNativeTaskStatus("in_progress")).toBe("in_progress");
    });

    it("maps completed to completed", () => {
      expect(mapNativeTaskStatus("completed")).toBe("completed");
    });

    it("passes through unknown statuses", () => {
      expect(mapNativeTaskStatus("blocked")).toBe("blocked");
    });

    it("defaults to open for empty/null", () => {
      expect(mapNativeTaskStatus("")).toBe("open");
      expect(mapNativeTaskStatus(null)).toBe("open");
      expect(mapNativeTaskStatus(undefined)).toBe("open");
    });
  });

  // ==========================================================================
  // handleNativeTaskCreatedEvent → real sidecar → MAP
  // ==========================================================================

  describe("handleNativeTaskCreatedEvent → sidecar → MAP", () => {
    beforeEach(() => {
      // Mock paths to point to our real test socket
      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath,
          inboxSocketPath: path.join(tmpDir, "inbox.sock"),
        })),
      }));
    });

    it("sends task.created + task.assigned MAP events for TaskCreate with owner", async () => {
      // Re-import to pick up mocked paths
      const { handleNativeTaskCreatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-1",
        tool_input: { id: "task-1", subject: "Fix auth bug", owner: "gsd-executor" },
        tool_output: { id: "task-1", status: "pending" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-1");

      // Wait for socket processing
      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).toHaveBeenCalledTimes(2);

      // First: task.created
      const [, createdPayload] = mockConn.send.mock.calls[0];
      expect(createdPayload.type).toBe("task.created");
      expect(createdPayload.task.id).toBe("task-1");
      expect(createdPayload.task.title).toBe("Fix auth bug");
      expect(createdPayload.task.status).toBe("open"); // pending → open
      expect(createdPayload.task.assignee).toBe("gsd-executor");
      expect(createdPayload._origin).toBe("gsd-executor");

      // Second: task.assigned
      const [, assignedPayload] = mockConn.send.mock.calls[1];
      expect(assignedPayload.type).toBe("task.assigned");
      expect(assignedPayload.taskId).toBe("task-1");
      expect(assignedPayload.agentId).toBe("gsd-executor");
    });

    it("sends only task.created (no assigned) when no owner", async () => {
      const { handleNativeTaskCreatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-2",
        tool_input: { subject: "Unassigned task" },
        tool_output: { id: "task-2", status: "pending" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-2");

      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).toHaveBeenCalledTimes(1);
      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.type).toBe("task.created");
      expect(payload.task.id).toBe("task-2");
      expect(payload._origin).toBe("sess-e2e-2"); // falls back to session_id
    });

    it("uses session_id as fallback agentId when no owner", async () => {
      const { handleNativeTaskCreatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-fallback",
        tool_input: { subject: "Test" },
        tool_output: { id: "task-3" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, null);

      await new Promise((r) => setTimeout(r, 200));

      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload._origin).toBe("sess-fallback");
    });
  });

  // ==========================================================================
  // handleNativeTaskUpdatedEvent → real sidecar → MAP
  // ==========================================================================

  describe("handleNativeTaskUpdatedEvent → sidecar → MAP", () => {
    beforeEach(() => {
      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath,
          inboxSocketPath: path.join(tmpDir, "inbox.sock"),
        })),
      }));
    });

    it("sends task.status MAP event for status change to in_progress", async () => {
      const { handleNativeTaskUpdatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-3",
        tool_input: { id: "task-10", status: "in_progress" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-3");

      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).toHaveBeenCalledTimes(1);
      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.type).toBe("task.status");
      expect(payload.taskId).toBe("task-10");
      expect(payload.current).toBe("in_progress");
      expect(payload._origin).toBe("sess-e2e-3");
    });

    it("sends task.status + task.completed for terminal status 'completed'", async () => {
      const { handleNativeTaskUpdatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-4",
        tool_input: { id: "task-11", status: "completed" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-4");

      await new Promise((r) => setTimeout(r, 200));

      // task.status + task.completed
      expect(mockConn.send).toHaveBeenCalledTimes(2);

      const types = mockConn.send.mock.calls.map(([, p]) => p.type);
      expect(types).toContain("task.status");
      expect(types).toContain("task.completed");
    });

    it("maps pending status to open in MAP event", async () => {
      const { handleNativeTaskUpdatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-5",
        tool_input: { id: "task-12", status: "pending" },
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-5");

      await new Promise((r) => setTimeout(r, 200));

      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.current).toBe("open"); // pending → open
    });

    it("does not send command when no taskId", async () => {
      const { handleNativeTaskUpdatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-6",
        tool_input: { status: "in_progress" }, // no id or taskId
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-6");

      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).not.toHaveBeenCalled();
    });

    it("does not send command when no status", async () => {
      const { handleNativeTaskUpdatedEvent: handler } = await import("../map-events.mjs");

      const hookData = {
        session_id: "sess-e2e-7",
        tool_input: { id: "task-13" }, // no status
      };

      const config = { map: { enabled: true } };
      await handler(config, hookData, "sess-e2e-7");

      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Full lifecycle: native TaskCreate → TaskUpdate → MAP event sequence
  // ==========================================================================

  describe("full lifecycle: TaskCreate → TaskUpdate → MAP events", () => {
    beforeEach(() => {
      vi.doMock("../paths.mjs", () => ({
        sessionPaths: vi.fn(() => ({
          socketPath,
          inboxSocketPath: path.join(tmpDir, "inbox.sock"),
        })),
      }));
    });

    it("TaskCreate + TaskUpdate(in_progress) + TaskUpdate(completed) produces correct MAP event sequence", async () => {
      const mod = await import("../map-events.mjs");
      const config = { map: { enabled: true } };

      // 1. TaskCreate
      await mod.handleNativeTaskCreatedEvent(config, {
        session_id: "sess-lifecycle",
        tool_input: { subject: "Build feature", owner: "worker-1" },
        tool_output: { id: "lifecycle-task", status: "pending" },
      }, "sess-lifecycle");

      await new Promise((r) => setTimeout(r, 100));

      // 2. TaskUpdate → in_progress
      await mod.handleNativeTaskUpdatedEvent(config, {
        session_id: "sess-lifecycle",
        tool_input: { id: "lifecycle-task", status: "in_progress" },
      }, "sess-lifecycle");

      await new Promise((r) => setTimeout(r, 100));

      // 3. TaskUpdate → completed
      await mod.handleNativeTaskUpdatedEvent(config, {
        session_id: "sess-lifecycle",
        tool_input: { id: "lifecycle-task", status: "completed" },
      }, "sess-lifecycle");

      await new Promise((r) => setTimeout(r, 200));

      // Verify the full MAP event sequence
      const types = mockConn.send.mock.calls.map(([, p]) => p.type);
      expect(types).toEqual([
        "task.created",     // TaskCreate → bridge-task-created
        "task.assigned",    // TaskCreate with owner → bridge-task-assigned
        "task.status",      // TaskUpdate(in_progress)
        "task.status",      // TaskUpdate(completed)
        "task.completed",   // Terminal status auto-emit
      ]);

      // Verify task.created details
      const createdPayload = mockConn.send.mock.calls[0][1];
      expect(createdPayload.task.id).toBe("lifecycle-task");
      expect(createdPayload.task.title).toBe("Build feature");
      expect(createdPayload.task.status).toBe("open");

      // Verify task.completed details
      const completedPayload = mockConn.send.mock.calls[4][1];
      expect(completedPayload.taskId).toBe("lifecycle-task");
    });
  });

  // ==========================================================================
  // Verify sendToSidecar sends correct wire format to real socket
  // ==========================================================================

  describe("sendToSidecar wire format verification", () => {
    it("sends NDJSON command that sidecar parses correctly", async () => {
      // Use the real sendToSidecar function against our real sidecar socket
      const result = await sendToSidecar({
        action: "bridge-task-created",
        task: { id: "wire-test-1", title: "Wire test", status: "open" },
        agentId: "tester",
      }, socketPath);

      expect(result).toBe(true);

      await new Promise((r) => setTimeout(r, 200));

      expect(mockConn.send).toHaveBeenCalledTimes(1);
      const [, payload] = mockConn.send.mock.calls[0];
      expect(payload.type).toBe("task.created");
      expect(payload.task.id).toBe("wire-test-1");
    });
  });
});
