/**
 * E2E tests: Real sidecar server → REAL MAP AgentConnection → TestServer
 *
 * Tests the full pipeline with no mocks on the MAP layer:
 *   Socket command → sidecar command handler → real AgentConnection → TestServer
 *
 * Verifies results by inspecting TestServer state (agents, messages, eventHistory).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createStreamPair, AgentConnection } from "@multi-agent-protocol/sdk";
import { TestServer } from "@multi-agent-protocol/sdk/testing";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      try {
        const parsed = JSON.parse(data.trim().split("\n").pop());
        client.destroy();
        resolve(parsed);
      } catch {
        // wait for more data
      }
    });
    client.on("error", reject);
    setTimeout(() => {
      client.destroy();
      try {
        resolve(JSON.parse(data.trim().split("\n").pop()));
      } catch {
        reject(new Error("Timeout waiting for response"));
      }
    }, 3000);
  });
}

/**
 * Create a real TestServer + AgentConnection pair, connected and registered.
 */
async function createLiveMapConnection(agentName = "sidecar-agent") {
  const server = new TestServer({ name: "test-map-server" });
  const [clientStream, serverStream] = createStreamPair();
  server.acceptConnection(serverStream);

  const conn = new AgentConnection(clientStream, {
    name: agentName,
    role: "sidecar",
  });

  await conn.connect();

  return { server, conn };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: sidecar socket → real MAP AgentConnection → TestServer", () => {
  let tmpDir;
  let socketPath;
  let socketServer;
  let mapServer;
  let conn;
  let registeredAgents;
  let handler;

  const SCOPE = "swarm:e2e-live";

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-live-map-");
    socketPath = path.join(tmpDir, "sidecar.sock");

    // Create real MAP connection
    const live = await createLiveMapConnection("e2e-sidecar");
    mapServer = live.server;
    conn = live.conn;

    // Create sidecar with real connection
    registeredAgents = new Map();
    handler = createCommandHandler(conn, SCOPE, registeredAgents);
    socketServer = createSocketServer(socketPath, handler);
    await new Promise((resolve) => socketServer.on("listening", resolve));
  });

  afterEach(async () => {
    if (socketServer) {
      await new Promise((resolve) => socketServer.close(resolve));
      socketServer = null;
    }
    if (conn && conn.isConnected) {
      try {
        await conn.disconnect();
      } catch {
        // ignore
      }
    }
    cleanupTmpDir(tmpDir);
  });

  // ==========================================================================
  // bridge-task-created → verify message in TestServer
  // ==========================================================================

  describe("bridge-task-created → TestServer", () => {
    it("sends task.created message that appears in TestServer messages", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "live-task-1",
          title: "Live E2E task",
          status: "open",
          assignee: "worker-1",
        },
        agentId: "worker-1",
      });

      expect(resp.ok).toBe(true);

      // Verify message arrived in TestServer
      const messages = mapServer.messages;
      const taskCreatedMsg = messages.find(
        (m) => m.payload?.type === "task.created" && m.payload?.task?.id === "live-task-1"
      );
      expect(taskCreatedMsg).toBeDefined();
      expect(taskCreatedMsg.payload.task.title).toBe("Live E2E task");
      expect(taskCreatedMsg.payload.task.assignee).toBe("worker-1");
      expect(taskCreatedMsg.payload._origin).toBe("worker-1");
    });
  });

  // ==========================================================================
  // bridge-task-status → verify status update in TestServer
  // ==========================================================================

  describe("bridge-task-status → TestServer", () => {
    it("sends task.status message for non-terminal status", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "live-task-2",
        previous: "open",
        current: "in_progress",
        agentId: "worker-2",
      });

      expect(resp.ok).toBe(true);

      const messages = mapServer.messages;
      const statusMsg = messages.find(
        (m) => m.payload?.type === "task.status" && m.payload?.taskId === "live-task-2"
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.payload.previous).toBe("open");
      expect(statusMsg.payload.current).toBe("in_progress");
      expect(statusMsg.payload._origin).toBe("worker-2");
    });

    it("sends both task.status and task.completed for terminal status", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "live-task-3",
        previous: "in_progress",
        current: "completed",
        agentId: "worker-3",
      });

      expect(resp.ok).toBe(true);

      const messages = mapServer.messages;
      const statusMsg = messages.find(
        (m) => m.payload?.type === "task.status" && m.payload?.taskId === "live-task-3"
      );
      expect(statusMsg).toBeDefined();
      expect(statusMsg.payload.current).toBe("completed");

      const completedMsg = messages.find(
        (m) => m.payload?.type === "task.completed" && m.payload?.taskId === "live-task-3"
      );
      expect(completedMsg).toBeDefined();
      expect(completedMsg.payload._origin).toBe("worker-3");
    });
  });

  // ==========================================================================
  // bridge-task-assigned → verify assignment in TestServer
  // ==========================================================================

  describe("bridge-task-assigned → TestServer", () => {
    it("sends task.assigned message that appears in TestServer", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "live-task-4",
        assignee: "developer-1",
        agentId: "developer-1",
      });

      expect(resp.ok).toBe(true);

      const messages = mapServer.messages;
      const assignedMsg = messages.find(
        (m) => m.payload?.type === "task.assigned" && m.payload?.taskId === "live-task-4"
      );
      expect(assignedMsg).toBeDefined();
      expect(assignedMsg.payload.agentId).toBe("developer-1");
      expect(assignedMsg.payload._origin).toBe("developer-1");
    });
  });

  // ==========================================================================
  // bridge-spawn-agent → verify agent in TestServer agents map
  // ==========================================================================

  describe("spawn agent → TestServer", () => {
    it("registers a child agent that appears in TestServer agents", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "live-child-1",
          name: "executor",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });

      expect(resp.ok).toBe(true);

      // TestServer now honors the client-requested agentId
      const spawnedAgentId = resp.agent?.agent?.id;
      expect(spawnedAgentId).toBe("live-child-1");

      // Verify agent registered in TestServer with the requested ID
      const childAgent = mapServer.agents.get("live-child-1");
      expect(childAgent).toBeDefined();
      expect(childAgent.name).toBe("executor");
      expect(childAgent.role).toBe("executor");

      // Verify local registeredAgents map (same key)
      expect(registeredAgents.has("live-child-1")).toBe(true);
      expect(registeredAgents.get("live-child-1").role).toBe("executor");
    });
  });

  // ==========================================================================
  // bridge-done-agent → verify agent removed from TestServer
  // ==========================================================================

  describe("done agent → TestServer", () => {
    it("removes agent from local tracking and attempts server unregister", async () => {
      // First spawn an agent
      const spawnResp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "live-child-done",
          name: "temp-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      expect(spawnResp.agent?.agent?.id).toBe("live-child-done");
      expect(mapServer.agents.has("live-child-done")).toBe(true);
      expect(registeredAgents.has("live-child-done")).toBe(true);

      // Now mark it done
      const resp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "live-child-done",
        reason: "task-finished",
      });

      expect(resp.ok).toBe(true);

      // Verify removed from local tracking
      expect(registeredAgents.has("live-child-done")).toBe(false);
    });
  });

  // ==========================================================================
  // bridge-update-state → verify state change in TestServer
  // ==========================================================================

  describe("state update → TestServer", () => {
    it("updates sidecar agent state via real AgentConnection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
      });

      expect(resp.ok).toBe(true);

      // Verify sidecar agent state changed in TestServer
      const sidecarAgent = mapServer.agents.get(conn.agentId);
      expect(sidecarAgent).toBeDefined();
      expect(sidecarAgent.state).toBe("busy");
    });

    it("tracks child agent state in local registeredAgents map", async () => {
      // Spawn a child first
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "state-child",
          name: "stateful-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      // Update child state (tracked locally, not via conn.updateState)
      const resp = await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
        agentId: "state-child",
      });

      expect(resp.ok).toBe(true);
      expect(registeredAgents.get("state-child").lastState).toBe("busy");
    });
  });

  // ==========================================================================
  // Emit action → verify message in TestServer
  // ==========================================================================

  describe("emit action → TestServer", () => {
    it("sends arbitrary event via real MAP connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "task.sync", uri: "claude://team/1", status: "open" },
        meta: { relationship: "broadcast" },
      });

      expect(resp.ok).toBe(true);

      const messages = mapServer.messages;
      const syncMsg = messages.find(
        (m) => m.payload?.type === "task.sync" && m.payload?.uri === "claude://team/1"
      );
      expect(syncMsg).toBeDefined();
      expect(syncMsg.payload.status).toBe("open");
    });
  });

  // ==========================================================================
  // Event history verification
  // ==========================================================================

  describe("TestServer event history", () => {
    it("records agent_registered events when agents are spawned", async () => {
      const spawnResp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "history-agent-1",
          name: "history-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      const spawnedId = spawnResp.agent?.agent?.id;

      const registeredEvents = mapServer.eventHistory.filter(
        (e) => e.event.type === "agent_registered"
      );
      // At least the sidecar agent + the spawned child
      expect(registeredEvents.length).toBeGreaterThanOrEqual(2);

      // Look for the child agent event using the server-assigned ID
      // Event data structure: { agentId, name, role, ownerId }
      const childEvent = registeredEvents.find(
        (e) => e.event.data?.agentId === spawnedId ||
               e.event.data?.name === "history-worker"
      );
      expect(childEvent).toBeDefined();
    });

    it("records message_sent events when messages are sent", async () => {
      await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: { id: "history-task", title: "Track me", status: "open", assignee: "x" },
        agentId: "x",
      });

      const messageSentEvents = mapServer.eventHistory.filter(
        (e) => e.event.type === "message_sent"
      );
      expect(messageSentEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Full lifecycle: spawn → create task → assign → status → complete → done
  // ==========================================================================

  describe("full lifecycle: spawn → task → assign → status → complete → done", () => {
    it("executes entire swarm task lifecycle via real MAP connection", async () => {
      // 1. Spawn agent
      const spawnResp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "lifecycle-agent",
          name: "lifecycle-worker",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });
      expect(spawnResp.ok).toBe(true);
      expect(spawnResp.agent?.agent?.id).toBe("lifecycle-agent");
      expect(mapServer.agents.has("lifecycle-agent")).toBe(true);

      // 2. Create task
      const createResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "lifecycle-task-1",
          title: "Build feature X",
          status: "open",
          assignee: "lifecycle-agent",
        },
        agentId: "lifecycle-agent",
      });
      expect(createResp.ok).toBe(true);

      // 3. Assign task
      const assignResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "lifecycle-task-1",
        assignee: "lifecycle-agent",
        agentId: "lifecycle-agent",
      });
      expect(assignResp.ok).toBe(true);

      // 4. Start working (in_progress)
      const progressResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "lifecycle-task-1",
        previous: "open",
        current: "in_progress",
        agentId: "lifecycle-agent",
      });
      expect(progressResp.ok).toBe(true);

      // 5. Complete task
      const completeResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "lifecycle-task-1",
        previous: "in_progress",
        current: "completed",
        agentId: "lifecycle-agent",
      });
      expect(completeResp.ok).toBe(true);

      // 6. Done agent
      const doneResp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "lifecycle-agent",
        reason: "completed",
      });
      expect(doneResp.ok).toBe(true);

      // ── Verify TestServer state ──

      // Local tracking should be cleaned up
      expect(registeredAgents.has("lifecycle-agent")).toBe(false);

      // All messages should be present
      const messages = mapServer.messages;
      const payloadTypes = messages.map((m) => m.payload?.type).filter(Boolean);

      expect(payloadTypes).toContain("task.created");
      expect(payloadTypes).toContain("task.assigned");
      expect(payloadTypes).toContain("task.status");
      expect(payloadTypes).toContain("task.completed");

      // Verify specific task messages
      const taskCreated = messages.find(
        (m) => m.payload?.type === "task.created" && m.payload?.task?.id === "lifecycle-task-1"
      );
      expect(taskCreated).toBeDefined();
      expect(taskCreated.payload.task.title).toBe("Build feature X");

      const taskAssigned = messages.find(
        (m) => m.payload?.type === "task.assigned" && m.payload?.taskId === "lifecycle-task-1"
      );
      expect(taskAssigned).toBeDefined();
      expect(taskAssigned.payload.agentId).toBe("lifecycle-agent");

      const statusMessages = messages.filter(
        (m) => m.payload?.type === "task.status" && m.payload?.taskId === "lifecycle-task-1"
      );
      expect(statusMessages.length).toBe(2); // in_progress + completed

      const taskCompleted = messages.find(
        (m) => m.payload?.type === "task.completed" && m.payload?.taskId === "lifecycle-task-1"
      );
      expect(taskCompleted).toBeDefined();

      // Verify event history includes agent registration
      const agentRegisteredEvents = mapServer.eventHistory.filter(
        (e) => e.event.type === "agent_registered"
      );
      // At least the sidecar agent + the lifecycle-agent child
      expect(agentRegisteredEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // Ping health check (no MAP interaction)
  // ==========================================================================

  describe("ping via socket", () => {
    it("responds with ok and pid", async () => {
      const resp = await sendSocketCommand(socketPath, { action: "ping" });
      expect(resp.ok).toBe(true);
      expect(resp.pid).toBe(process.pid);
    });
  });
});
