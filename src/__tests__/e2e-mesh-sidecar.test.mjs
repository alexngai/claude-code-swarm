/**
 * E2E tests: Real MeshPeer (0.2.0) + agent-inbox → sidecar command handler → real MapServer
 *
 * Tests the full mesh-mode pipeline with NO mocks:
 *   Socket command → sidecar command handler (mesh mode) →
 *   real embedded MeshPeer (via createEmbedded) → real MapServer
 *
 * Also tests the agent-inbox integration: spawn registers agents
 * in both the MapServer and inbox storage.
 *
 * Verifies results by inspecting MapServer state (agents, scopes)
 * and exercises 0.2.0 features (parent-child hierarchy, broadcastToScope,
 * connection.isRegistered, connection.state).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { createMeshPeer, createMeshInbox } from "../mesh-connection.mjs";
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: sidecar socket → real MeshPeer 0.2.0 + agent-inbox (mesh mode)", () => {
  let tmpDir;
  let socketPath;
  let inboxSocketPath;
  let socketServer;
  let meshResult;
  let inboxInstance;
  let registeredAgents;
  let handler;

  const SCOPE = "swarm:e2e-mesh";

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-mesh-sidecar-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    inboxSocketPath = path.join(tmpDir, "inbox.sock");

    // Create real MeshPeer via createEmbedded (0.2.0 API)
    meshResult = await createMeshPeer({
      peerId: "e2e-mesh-sidecar",
      scope: SCOPE,
      systemId: "sys-e2e",
    });

    // Verify embedded peer is set up correctly
    expect(meshResult.peer.server).toBeDefined();
    expect(meshResult.connection.isRegistered).toBe(true);

    // Create real agent-inbox on the MeshPeer
    inboxInstance = await createMeshInbox({
      meshPeer: meshResult.peer,
      scope: SCOPE,
      systemId: "sys-e2e",
      socketPath: inboxSocketPath,
      inboxConfig: {},
    });

    // Create sidecar command handler in mesh mode
    registeredAgents = new Map();
    handler = createCommandHandler(meshResult.connection, SCOPE, registeredAgents, {
      inboxInstance,
      meshPeer: meshResult.peer,
      transportMode: "mesh",
    });
    socketServer = createSocketServer(socketPath, handler);
    await new Promise((resolve) => socketServer.on("listening", resolve));
  });

  afterEach(async () => {
    if (socketServer) {
      await new Promise((resolve) => socketServer.close(resolve));
      socketServer = null;
    }
    if (inboxInstance?.stop) {
      try { await inboxInstance.stop(); } catch { /* ignore */ }
    }
    if (meshResult?.connection) {
      try { await meshResult.connection.unregister(); } catch { /* ignore */ }
    }
    if (meshResult?.peer) {
      try { await meshResult.peer.stop(); } catch { /* ignore */ }
    }
    cleanupTmpDir(tmpDir);
  });

  // ==========================================================================
  // Spawn agent → verify in MapServer + inbox storage + local tracking
  // ==========================================================================

  describe("spawn agent (mesh mode)", () => {
    it("registers agent in MapServer, inbox storage, and local tracking", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "mesh-worker-1",
          name: "executor",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });

      expect(resp.ok).toBe(true);
      expect(resp.agent.agentId).toBe("mesh-worker-1");

      // Verify agent in MapServer
      const agents = meshResult.peer.server.listAgents();
      const worker = agents.find((a) => a.id === "mesh-worker-1");
      expect(worker).toBeDefined();
      expect(worker.name).toBe("executor");
      expect(worker.role).toBe("executor");

      // Verify agent in inbox storage
      const inboxAgent = inboxInstance.storage.getAgent("mesh-worker-1");
      expect(inboxAgent).toBeDefined();
      expect(inboxAgent.status).toBe("active");

      // Verify local tracking
      expect(registeredAgents.has("mesh-worker-1")).toBe(true);
      expect(registeredAgents.get("mesh-worker-1").role).toBe("executor");
    });

    it("spawned agent is visible via peer.server.listAgents()", async () => {
      const agentsBefore = meshResult.peer.server.listAgents();
      const countBefore = agentsBefore.length;

      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "visibility-test",
          name: "visible-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      const agentsAfter = meshResult.peer.server.listAgents();
      expect(agentsAfter.length).toBe(countBefore + 1);
      expect(agentsAfter.find((a) => a.id === "visibility-test")).toBeDefined();
    });
  });

  // ==========================================================================
  // Done agent → verify removed from MapServer + local tracking
  // ==========================================================================

  describe("done agent (mesh mode)", () => {
    it("removes agent from MapServer and local tracking", async () => {
      // First spawn
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "mesh-temp",
          name: "temp-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      const agentsBefore = meshResult.peer.server.listAgents();
      expect(agentsBefore.find((a) => a.id === "mesh-temp")).toBeDefined();
      expect(registeredAgents.has("mesh-temp")).toBe(true);

      // Now mark done
      const resp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "mesh-temp",
        reason: "completed",
      });

      expect(resp.ok).toBe(true);

      // Verify removed from local tracking
      expect(registeredAgents.has("mesh-temp")).toBe(false);

      // Verify unregistered from MapServer
      const agentsAfter = meshResult.peer.server.listAgents();
      expect(agentsAfter.find((a) => a.id === "mesh-temp")).toBeUndefined();
    });

    it("marks agent as disconnected in inbox storage", async () => {
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "inbox-done-test",
          name: "temp",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      // Verify active in inbox
      const beforeAgent = inboxInstance.storage.getAgent("inbox-done-test");
      expect(beforeAgent.status).toBe("active");

      await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "inbox-done-test",
        reason: "completed",
      });

      // Verify marked disconnected (not deleted) in inbox storage
      const afterAgent = inboxInstance.storage.getAgent("inbox-done-test");
      expect(afterAgent).toBeDefined();
      expect(afterAgent.status).toBe("disconnected");
    });
  });

  // ==========================================================================
  // Task bridge events → verify messages sent via MeshPeer connection
  // ==========================================================================

  describe("bridge-task-created (mesh mode)", () => {
    it("sends task.created message via MeshPeer connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "mesh-task-1",
          title: "Mesh E2E task",
          status: "open",
          assignee: "worker-1",
        },
        agentId: "worker-1",
      });

      expect(resp.ok).toBe(true);
      // The message was sent via connection.send() — no error means success
    });
  });

  describe("bridge-task-status (mesh mode)", () => {
    it("sends task.status via MeshPeer connection for non-terminal status", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "mesh-task-2",
        previous: "open",
        current: "in_progress",
        agentId: "worker-2",
      });

      expect(resp.ok).toBe(true);
    });

    it("sends task.status + task.completed for terminal status", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "mesh-task-3",
        previous: "in_progress",
        current: "completed",
        agentId: "worker-3",
      });

      expect(resp.ok).toBe(true);
    });
  });

  describe("bridge-task-assigned (mesh mode)", () => {
    it("sends task.assigned via MeshPeer connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "bridge-task-assigned",
        taskId: "mesh-task-4",
        assignee: "developer-1",
        agentId: "developer-1",
      });

      expect(resp.ok).toBe(true);
    });
  });

  // ==========================================================================
  // State update → verify in local tracking + connection state
  // ==========================================================================

  describe("state update (mesh mode)", () => {
    it("updates sidecar agent state via MeshPeer connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
      });

      expect(resp.ok).toBe(true);
      // Sidecar connection state updated via updateState()
      expect(meshResult.connection.state).toBe("busy");
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
  // Emit action → verify sent via MeshPeer connection
  // ==========================================================================

  describe("emit action (mesh mode)", () => {
    it("sends arbitrary event via MeshPeer connection", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "task.sync", uri: "claude://team/1", status: "open" },
        meta: { relationship: "broadcast" },
      });

      expect(resp.ok).toBe(true);
    });
  });

  // ==========================================================================
  // Ping with transport info
  // ==========================================================================

  describe("ping (mesh mode)", () => {
    it("responds with ok, pid, and transport mode", async () => {
      const resp = await sendSocketCommand(socketPath, { action: "ping" });
      expect(resp.ok).toBe(true);
      expect(resp.pid).toBe(process.pid);
      expect(resp.transport).toBe("mesh");
    });
  });

  // ==========================================================================
  // Full lifecycle: spawn → tasks → state → done
  // ==========================================================================

  describe("full lifecycle (mesh mode)", () => {
    it("executes entire swarm task lifecycle via real embedded MeshPeer", async () => {
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

      // Verify in MapServer
      const agents = meshResult.peer.server.listAgents();
      expect(agents.find((a) => a.id === "lifecycle-agent")).toBeDefined();

      // 2. Create task
      const createResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: {
          id: "lc-task-1",
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
        taskId: "lc-task-1",
        assignee: "lifecycle-agent",
        agentId: "lifecycle-agent",
      });
      expect(assignResp.ok).toBe(true);

      // 4. Start working
      const progressResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "lc-task-1",
        previous: "open",
        current: "in_progress",
        agentId: "lifecycle-agent",
      });
      expect(progressResp.ok).toBe(true);

      // 5. Update state
      const stateResp = await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
        agentId: "lifecycle-agent",
      });
      expect(stateResp.ok).toBe(true);

      // 6. Complete task
      const completeResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-status",
        taskId: "lc-task-1",
        previous: "in_progress",
        current: "completed",
        agentId: "lifecycle-agent",
      });
      expect(completeResp.ok).toBe(true);

      // 7. Done agent
      const doneResp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "lifecycle-agent",
        reason: "completed",
      });
      expect(doneResp.ok).toBe(true);

      // ── Verify final state ──

      // Agent removed from local tracking
      expect(registeredAgents.has("lifecycle-agent")).toBe(false);

      // Agent unregistered from MapServer
      const finalAgents = meshResult.peer.server.listAgents();
      expect(finalAgents.find((a) => a.id === "lifecycle-agent")).toBeUndefined();

      // Inbox storage still has the agent record (marked disconnected)
      const inboxAgent = inboxInstance.storage.getAgent("lifecycle-agent");
      expect(inboxAgent).toBeDefined();
      expect(inboxAgent.status).toBe("disconnected");
    });
  });

  // ==========================================================================
  // Multiple agents: spawn multiple, interact, done all
  // ==========================================================================

  describe("multiple agents (mesh mode)", () => {
    it("manages multiple concurrent agents via embedded MeshPeer", async () => {
      const agentIds = ["multi-1", "multi-2", "multi-3"];

      // Spawn all
      for (const id of agentIds) {
        const resp = await sendSocketCommand(socketPath, {
          action: "spawn",
          agent: {
            agentId: id,
            name: `worker-${id}`,
            role: "worker",
            scopes: [SCOPE],
            metadata: {},
          },
        });
        expect(resp.ok).toBe(true);
      }

      // Verify all in MapServer
      const agents = meshResult.peer.server.listAgents();
      for (const id of agentIds) {
        expect(agents.find((a) => a.id === id)).toBeDefined();
      }
      expect(registeredAgents.size).toBe(3);

      // Each creates a task
      for (const id of agentIds) {
        await sendSocketCommand(socketPath, {
          action: "bridge-task-created",
          task: { id: `task-${id}`, title: `Task for ${id}`, status: "open", assignee: id },
          agentId: id,
        });
      }

      // Done all
      for (const id of agentIds) {
        await sendSocketCommand(socketPath, {
          action: "done",
          agentId: id,
          reason: "completed",
        });
      }

      expect(registeredAgents.size).toBe(0);

      // All unregistered from MapServer
      const finalAgents = meshResult.peer.server.listAgents();
      for (const id of agentIds) {
        expect(finalAgents.find((a) => a.id === id)).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // 0.2.0-specific: verify embedded peer properties
  // ==========================================================================

  describe("embedded MeshPeer properties (0.2.0)", () => {
    it("sidecar connection is registered and has correct initial state", () => {
      expect(meshResult.connection.isRegistered).toBe(true);
      expect(meshResult.connection.agent).toBeDefined();
      expect(meshResult.connection.agentId).toBe("e2e-mesh-sidecar-agent");
    });

    it("MapServer tracks all agents including sidecar", async () => {
      // The sidecar agent itself should be in the MapServer
      const agents = meshResult.peer.server.listAgents();
      const sidecar = agents.find((a) => a.id === "e2e-mesh-sidecar-agent");
      expect(sidecar).toBeDefined();
      expect(sidecar.role).toBe("sidecar");

      // Spawn a worker — both sidecar and worker should be listed
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "tracked-worker",
          name: "worker",
          role: "executor",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      const updatedAgents = meshResult.peer.server.listAgents();
      expect(updatedAgents.find((a) => a.id === "e2e-mesh-sidecar-agent")).toBeDefined();
      expect(updatedAgents.find((a) => a.id === "tracked-worker")).toBeDefined();
    });
  });
});
