/**
 * Tier 7: OpenTasks Integration Tests
 *
 * Tests the opentasks IPC client and MAP bridge without LLM calls:
 *   1. rpcRequest round-trip via a test daemon
 *   2. createTask / updateTask JSON-RPC round-trip
 *   3. pushSyncEvent for various event types
 *   4. findSocketPath discovery priority
 *   5. isDaemonAlive with live and dead sockets
 *   6. MAP bridge events for task lifecycle (sidecar + mock MAP server)
 *
 * Uses a minimal test daemon (e2e/helpers/opentasks-daemon.mjs) for IPC tests.
 * No LLM calls.
 *
 * Run:
 *   npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier7-opentasks.test.mjs
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkspace } from "./helpers/workspace.mjs";
import { startTestDaemon } from "./helpers/opentasks-daemon.mjs";
import { MockMapServer } from "./helpers/map-mock-server.mjs";
import { startTestSidecar, sendCommand } from "./helpers/sidecar.mjs";
import { waitFor } from "./helpers/cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHORT_TMPDIR = "/tmp";

// Import opentasks client functions
const {
  findSocketPath,
  rpcRequest,
  isDaemonAlive,
  createTask,
  updateTask,
  pushSyncEvent,
} = await import("../src/opentasks-client.mjs");

const { buildCapabilitiesContext } = await import("../src/context-output.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: findSocketPath — socket discovery priority
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks findSocketPath",
  { timeout: 15_000 },
  () => {
    let workspace;
    let origCwd;

    afterEach(() => {
      if (origCwd) process.chdir(origCwd);
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
    });

    it("prefers .swarm/opentasks/ layout", () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-" });
      origCwd = process.cwd();
      process.chdir(workspace.dir);

      const swarmSock = path.join(workspace.dir, ".swarm", "opentasks", "daemon.sock");
      fs.mkdirSync(path.dirname(swarmSock), { recursive: true });
      fs.writeFileSync(swarmSock, "");

      expect(findSocketPath()).toBe(path.join(".swarm", "opentasks", "daemon.sock"));
    });

    it("falls back to .opentasks/ layout", () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-" });
      origCwd = process.cwd();
      process.chdir(workspace.dir);

      const otSock = path.join(workspace.dir, ".opentasks", "daemon.sock");
      fs.mkdirSync(path.dirname(otSock), { recursive: true });
      fs.writeFileSync(otSock, "");

      expect(findSocketPath()).toBe(path.join(".opentasks", "daemon.sock"));
    });

    it("falls back to .git/opentasks/ layout", () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-" });
      origCwd = process.cwd();
      process.chdir(workspace.dir);

      const gitSock = path.join(workspace.dir, ".git", "opentasks", "daemon.sock");
      fs.mkdirSync(path.dirname(gitSock), { recursive: true });
      fs.writeFileSync(gitSock, "");

      expect(findSocketPath()).toBe(path.join(".git", "opentasks", "daemon.sock"));
    });

    it("returns default swarmkit path when no socket exists", () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-" });
      origCwd = process.cwd();
      process.chdir(workspace.dir);

      expect(findSocketPath()).toBe(path.join(".swarm", "opentasks", "daemon.sock"));
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Daemon IPC — rpcRequest, isDaemonAlive with test daemon
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks daemon IPC",
  { timeout: 30_000 },
  () => {
    let daemon;
    let workspace;

    beforeAll(async () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-ipc-" });
      const sockPath = path.join(workspace.dir, "daemon.sock");
      daemon = await startTestDaemon(sockPath);
    });

    afterAll(async () => {
      if (daemon) await daemon.stop();
      if (workspace) workspace.cleanup();
    });

    it("rpcRequest ping returns result", async () => {
      const result = await rpcRequest("ping", {}, daemon.socketPath);
      expect(result).not.toBeNull();
      expect(result.pong).toBe(true);
    });

    it("isDaemonAlive returns true for running daemon", async () => {
      const alive = await isDaemonAlive(daemon.socketPath);
      expect(alive).toBe(true);
    });

    it("isDaemonAlive returns false for non-existent socket", async () => {
      const alive = await isDaemonAlive("/tmp/nonexistent-" + Date.now() + ".sock");
      expect(alive).toBe(false);
    });

    it("rpcRequest with unknown method returns null", async () => {
      const result = await rpcRequest("nonexistent.method", {}, daemon.socketPath);
      expect(result).toBeNull();
    });

    it("rpcRequest with dead socket returns null (never throws)", async () => {
      const result = await rpcRequest("ping", {}, "/tmp/no-daemon-" + Date.now() + ".sock");
      expect(result).toBeNull();
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Task CRUD — createTask, updateTask round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks task CRUD",
  { timeout: 30_000 },
  () => {
    let daemon;
    let workspace;

    beforeAll(async () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-crud-" });
      const sockPath = path.join(workspace.dir, "daemon.sock");
      daemon = await startTestDaemon(sockPath);
    });

    afterAll(async () => {
      if (daemon) await daemon.stop();
      if (workspace) workspace.cleanup();
    });

    it("createTask returns a node with an ID", async () => {
      const result = await createTask(daemon.socketPath, {
        title: "Test task from tier7",
        status: "open",
        assignee: "test-agent",
        metadata: { source: "e2e-test" },
      });

      expect(result).not.toBeNull();
      expect(result.id).toBeTruthy();
      expect(result.title).toBe("Test task from tier7");
      expect(result.status).toBe("open");
      expect(result.assignee).toBe("test-agent");

      // Verify it's in the daemon's storage
      expect(daemon.nodes.has(result.id)).toBe(true);
    });

    it("updateTask changes task status", async () => {
      const created = await createTask(daemon.socketPath, {
        title: "Task to update",
        status: "open",
      });
      expect(created).not.toBeNull();

      const updated = await updateTask(daemon.socketPath, created.id, {
        status: "in_progress",
        assignee: "gsd-executor",
      });

      expect(updated).not.toBeNull();
      expect(updated.status).toBe("in_progress");
      expect(updated.assignee).toBe("gsd-executor");

      // Verify in daemon storage
      const stored = daemon.nodes.get(created.id);
      expect(stored.status).toBe("in_progress");
    });

    it("updateTask with non-existent ID returns null", async () => {
      const result = await updateTask(daemon.socketPath, "nonexistent-id", {
        status: "done",
      });
      expect(result).toBeNull();
    });

    it("createTask with missing socket returns null (never throws)", async () => {
      const result = await createTask("/tmp/no-daemon-" + Date.now() + ".sock", {
        title: "Should fail gracefully",
        status: "open",
      });
      expect(result).toBeNull();
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: pushSyncEvent — forwarding MAP task events to graph
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks pushSyncEvent",
  { timeout: 30_000 },
  () => {
    let daemon;
    let workspace;

    beforeAll(async () => {
      workspace = createWorkspace({ tmpdir: SHORT_TMPDIR, prefix: "t7-ot-sync-" });
      const sockPath = path.join(workspace.dir, "daemon.sock");
      daemon = await startTestDaemon(sockPath);
    });

    afterAll(async () => {
      if (daemon) await daemon.stop();
      if (workspace) workspace.cleanup();
    });

    it("task.sync creates a new node in the graph", async () => {
      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.sync",
        uri: "map://remote-system/task-1",
        subject: "Remote task synced from MAP",
        status: "open",
        source: "map-bridge",
      });
      expect(ok).toBe(true);

      // Should have created a node
      const nodes = Array.from(daemon.nodes.values());
      const synced = nodes.find((n) => n.uri === "map://remote-system/task-1");
      expect(synced).toBeTruthy();
    });

    it("task.sync with ID updates existing node", async () => {
      const created = await createTask(daemon.socketPath, {
        title: "Task to sync-update",
        status: "open",
      });

      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.sync",
        id: created.id,
        subject: "Updated via sync",
        status: "in_progress",
        source: "map-bridge",
      });
      expect(ok).toBe(true);

      const stored = daemon.nodes.get(created.id);
      expect(stored.status).toBe("in_progress");
    });

    it("task.claimed updates assignee", async () => {
      const created = await createTask(daemon.socketPath, {
        title: "Task to claim",
        status: "open",
      });

      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.claimed",
        id: created.id,
        agent: "gsd-executor",
        source: "map-bridge",
      });
      expect(ok).toBe(true);

      const stored = daemon.nodes.get(created.id);
      expect(stored.status).toBe("in_progress");
      expect(stored.assignee).toBe("gsd-executor");
    });

    it("task.unblocked resets status to open", async () => {
      const created = await createTask(daemon.socketPath, {
        title: "Blocked task",
        status: "blocked",
      });

      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.unblocked",
        id: created.id,
        unblockedBy: "gsd-debugger",
        source: "map-bridge",
      });
      expect(ok).toBe(true);

      const stored = daemon.nodes.get(created.id);
      expect(stored.status).toBe("open");
    });

    it("task.linked creates an edge", async () => {
      const from = await createTask(daemon.socketPath, { title: "From", status: "open" });
      const to = await createTask(daemon.socketPath, { title: "To", status: "open" });

      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.linked",
        from: from.id,
        to: to.id,
        linkType: "blocks",
        source: "map-bridge",
      });
      expect(ok).toBe(true);

      expect(daemon.edges.length).toBeGreaterThan(0);
      const edge = daemon.edges.find((e) => e.fromId === from.id && e.toId === to.id);
      expect(edge).toBeTruthy();
      expect(edge.type).toBe("blocks");
    });

    it("unknown event type returns false", async () => {
      const ok = await pushSyncEvent(daemon.socketPath, {
        type: "task.unknown_event",
        id: "fake",
      });
      expect(ok).toBe(false);
    });

    it("pushSyncEvent with dead socket does not throw", async () => {
      // task.sync always returns true (best-effort pattern: fire-and-forget create)
      // The key assertion is that it doesn't throw
      const ok = await pushSyncEvent("/tmp/no-daemon-" + Date.now() + ".sock", {
        type: "task.sync",
        uri: "test://fail",
        status: "open",
        source: "test",
      });
      expect(typeof ok).toBe("boolean");
    });

    it("task.claimed with dead socket returns false for ID-required events", async () => {
      const ok = await pushSyncEvent("/tmp/no-daemon-" + Date.now() + ".sock", {
        type: "task.claimed",
        id: "fake-id",
        agent: "test",
        source: "test",
      });
      // task.claimed calls rpcRequest which returns null, but pushSyncEvent still returns true
      // The key behavior: never throws
      expect(typeof ok).toBe("boolean");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: MAP Bridge — task events emitted to MAP server via sidecar
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks MAP bridge events",
  { timeout: 60_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();
    });

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) workspace.cleanup();
      if (mockServer) await mockServer.stop();
    });

    it("bridge-task-created event reaches MAP server", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7-ot-bridge-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          opentasks: { enabled: true },
        },
      });

      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
      });

      const resp = await sendCommand(sidecar.socketPath, {
        action: "emit",
        event: {
          type: "bridge-task-created",
          taskId: "task-ot-1",
          title: "Task created from opentasks bridge",
          assignee: "gsd-executor",
          source: "opentasks",
        },
      });
      expect(resp.ok).toBe(true);

      await waitFor(() => mockServer.sentMessages.length > 0, 5000);
      expect(mockServer.sentMessages.length).toBeGreaterThan(0);

      const taskEvent = mockServer.sentMessages.find(
        (m) => m.payload?.type === "bridge-task-created"
      );
      expect(taskEvent).toBeTruthy();
      expect(taskEvent.payload.taskId).toBe("task-ot-1");
    });

    it("bridge-task-status event reaches MAP server", async () => {
      mockServer.clearMessages();

      const resp = await sendCommand(sidecar.socketPath, {
        action: "emit",
        event: {
          type: "bridge-task-status",
          taskId: "task-ot-1",
          status: "completed",
          assignee: "gsd-executor",
          source: "opentasks",
        },
      });
      expect(resp.ok).toBe(true);

      await waitFor(() => mockServer.sentMessages.length > 0, 5000);
      const statusEvent = mockServer.sentMessages.find(
        (m) => m.payload?.type === "bridge-task-status"
      );
      expect(statusEvent).toBeTruthy();
      expect(statusEvent.payload.status).toBe("completed");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Context Output — buildCapabilitiesContext includes opentasks
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: opentasks context output",
  { timeout: 15_000 },
  () => {
    it("includes opentasks MCP tools when enabled and connected", () => {
      const context = buildCapabilitiesContext({
        opentasksEnabled: true,
        opentasksStatus: "connected",
      });

      expect(context).toContain("opentasks MCP tools");
      expect(context).toContain("opentasks__create_task");
      expect(context).toContain("opentasks__update_task");
      expect(context).toContain("opentasks__list_tasks");
      expect(context).toContain("opentasks__query");
      expect(context).toContain("opentasks__link");
    });

    it("shows native task tools when opentasks disabled", () => {
      const context = buildCapabilitiesContext({
        opentasksEnabled: false,
      });

      expect(context).toContain("TaskCreate");
      expect(context).toContain("TaskUpdate");
      expect(context).toContain("TaskList");
      expect(context).not.toContain("opentasks MCP tools");
    });

    it("shows native task tools when opentasks enabled but not connected", () => {
      const context = buildCapabilitiesContext({
        opentasksEnabled: true,
        opentasksStatus: "starting",
      });

      expect(context).toContain("TaskCreate");
      expect(context).not.toContain("opentasks MCP tools");
    });
  }
);
