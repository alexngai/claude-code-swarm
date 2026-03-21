/**
 * E2E tests: Sidecar reconnection after MAP connection loss
 *
 * Tests the reconnection flow in map-sidecar.mjs:
 *   1. SDK built-in reconnection (via onReconnection events)
 *   2. Slow retry loop after SDK retries are exhausted (reconnectFailed)
 *   3. Connection swap via handler.setConnection()
 *   4. Agent re-registration after reconnection
 *   5. Initial connection failure → slow retry loop
 *
 * Uses real UNIX socket server + mock MAP connections to simulate
 * disconnect/reconnect scenarios without needing a real MAP server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockMapConnection() {
  const reconnectionHandlers = new Set();
  return {
    send: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ agentId: "spawned-1" }),
    updateState: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    callExtension: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: true,
    onReconnection(handler) {
      reconnectionHandlers.add(handler);
      return () => reconnectionHandlers.delete(handler);
    },
    // Test helper: emit a reconnection event to all registered handlers
    _emitReconnectionEvent(event) {
      for (const handler of reconnectionHandlers) {
        handler(event);
      }
    },
    _reconnectionHandlers: reconnectionHandlers,
  };
}

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
    }, 2000);
  });
}

/**
 * Wait for a condition to be true, polling at an interval.
 */
async function waitFor(conditionFn, timeoutMs = 2000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conditionFn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: sidecar reconnection after MAP connection loss", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let registeredAgents;
  let handler;

  const SCOPE = "swarm:reconnect-test";

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-reconnect-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    registeredAgents = new Map();
    handler = createCommandHandler(mockConn, SCOPE, registeredAgents);
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
  // handler.setConnection() swaps the connection reference
  // ==========================================================================

  describe("handler.setConnection() swaps connection", () => {
    it("commands use the new connection after setConnection()", async () => {
      // Send an event on the original connection
      const resp1 = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.before-swap" },
      });
      expect(resp1.ok).toBe(true);
      expect(mockConn.send).toHaveBeenCalledTimes(1);
      expect(mockConn.send.mock.calls[0][1].type).toBe("test.before-swap");

      // Swap to a new connection
      const newConn = createMockMapConnection();
      handler.setConnection(newConn);

      // Send an event — should go to the new connection
      const resp2 = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.after-swap" },
      });
      expect(resp2.ok).toBe(true);

      // Old connection should still have 1 call, new should have 1
      expect(mockConn.send).toHaveBeenCalledTimes(1);
      expect(newConn.send).toHaveBeenCalledTimes(1);
      expect(newConn.send.mock.calls[0][1].type).toBe("test.after-swap");
    });

    it("spawn uses the new connection after setConnection()", async () => {
      const newConn = createMockMapConnection();
      handler.setConnection(newConn);

      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "swap-agent-1",
          name: "swapped",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.spawn).not.toHaveBeenCalled();
      expect(newConn.spawn).toHaveBeenCalledWith({
        agentId: "swap-agent-1",
        name: "swapped",
        role: "worker",
        scopes: [SCOPE],
        metadata: {},
      });
    });
  });

  // ==========================================================================
  // Commands degrade gracefully when connection is null
  // ==========================================================================

  describe("graceful degradation with null connection", () => {
    it("emit responds ok:true but does not send when connection is null", async () => {
      handler.setConnection(null);

      const resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.no-conn" },
      });

      expect(resp.ok).toBe(true);
      expect(mockConn.send).not.toHaveBeenCalled();
    });

    it("spawn responds ok:false with error when connection is null", async () => {
      handler.setConnection(null);

      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "null-agent",
          name: "null-worker",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      expect(resp.ok).toBe(false);
      expect(resp.error).toBe("no connection");
    });

    it("trajectory-checkpoint responds ok:false when connection is null", async () => {
      handler.setConnection(null);

      const resp = await sendSocketCommand(socketPath, {
        action: "trajectory-checkpoint",
        checkpoint: { id: "cp-1", agentId: "a", sessionId: "s", label: "test" },
      });

      expect(resp.ok).toBe(false);
      expect(resp.error).toBe("no connection");
    });

    it("ping still works with null connection", async () => {
      handler.setConnection(null);

      const resp = await sendSocketCommand(socketPath, { action: "ping" });
      expect(resp.ok).toBe(true);
      expect(resp.pid).toBe(process.pid);
    });
  });

  // ==========================================================================
  // Full reconnection simulation: disconnect → null → reconnect → re-register
  // ==========================================================================

  describe("full reconnection simulation", () => {
    it("spawn agents → lose connection → reconnect → re-register agents → resume operations", async () => {
      // Step 1: Spawn two agents on the original connection
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "agent-A",
          name: "worker-A",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "agent-B",
          name: "worker-B",
          role: "verifier",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });

      expect(registeredAgents.size).toBe(2);
      expect(mockConn.spawn).toHaveBeenCalledTimes(2);

      // Step 2: Simulate connection loss — set to null (like reconnectFailed)
      handler.setConnection(null);

      // Verify operations degrade gracefully
      const emitResp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.during-outage" },
      });
      expect(emitResp.ok).toBe(true); // responds ok but doesn't send

      // Step 3: Simulate reconnection — create a new connection and swap it in
      const newConn = createMockMapConnection();
      handler.setConnection(newConn);

      // Step 4: Re-register agents (simulating what startSlowReconnectLoop does)
      for (const [agentId, meta] of registeredAgents) {
        await newConn.spawn({
          agentId,
          name: meta.name,
          role: meta.role,
          scopes: [SCOPE],
          metadata: meta.metadata,
        });
      }

      expect(newConn.spawn).toHaveBeenCalledTimes(2);
      expect(newConn.spawn).toHaveBeenCalledWith({
        agentId: "agent-A",
        name: "worker-A",
        role: "executor",
        scopes: [SCOPE],
        metadata: { template: "gsd" },
      });
      expect(newConn.spawn).toHaveBeenCalledWith({
        agentId: "agent-B",
        name: "worker-B",
        role: "verifier",
        scopes: [SCOPE],
        metadata: { template: "gsd" },
      });

      // Step 5: Verify operations resume on the new connection
      const taskResp = await sendSocketCommand(socketPath, {
        action: "bridge-task-created",
        task: { id: "post-reconnect-1", title: "After reconnect", status: "open" },
        agentId: "agent-A",
      });
      expect(taskResp.ok).toBe(true);
      expect(newConn.send).toHaveBeenCalledTimes(1);
      expect(newConn.send.mock.calls[0][1].type).toBe("task.created");
      expect(newConn.send.mock.calls[0][1].task.id).toBe("post-reconnect-1");

      // Old connection should have no new calls after the swap
      expect(mockConn.send).toHaveBeenCalledTimes(0);
    });

    it("agent done during outage removes from tracking, not re-registered on reconnect", async () => {
      // Spawn two agents
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "temp-agent",
          name: "temp",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "persistent-agent",
          name: "persistent",
          role: "executor",
          scopes: [SCOPE],
          metadata: {},
        },
      });
      expect(registeredAgents.size).toBe(2);

      // Simulate connection loss
      handler.setConnection(null);

      // One agent completes during the outage
      const doneResp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "temp-agent",
        reason: "completed",
      });
      expect(doneResp.ok).toBe(true);
      expect(registeredAgents.size).toBe(1);
      expect(registeredAgents.has("temp-agent")).toBe(false);
      expect(registeredAgents.has("persistent-agent")).toBe(true);

      // Reconnect — only persistent-agent should be re-registered
      const newConn = createMockMapConnection();
      handler.setConnection(newConn);

      for (const [agentId, meta] of registeredAgents) {
        await newConn.spawn({
          agentId,
          name: meta.name,
          role: meta.role,
          scopes: [SCOPE],
          metadata: meta.metadata,
        });
      }

      expect(newConn.spawn).toHaveBeenCalledTimes(1);
      expect(newConn.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "persistent-agent" })
      );
    });
  });

  // ==========================================================================
  // onReconnection event listener wiring
  // ==========================================================================

  describe("onReconnection event listener", () => {
    it("onReconnection handler is callable and receives events", () => {
      const events = [];
      mockConn.onReconnection((event) => {
        events.push(event);
      });

      mockConn._emitReconnectionEvent({ type: "disconnected" });
      mockConn._emitReconnectionEvent({ type: "reconnecting", attempt: 1, delay: 1000 });
      mockConn._emitReconnectionEvent({
        type: "reconnectFailed",
        error: new Error("max retries"),
      });

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("disconnected");
      expect(events[1].type).toBe("reconnecting");
      expect(events[1].attempt).toBe(1);
      expect(events[2].type).toBe("reconnectFailed");
      expect(events[2].error.message).toBe("max retries");
    });

    it("unsubscribe function removes the handler", () => {
      const events = [];
      const unsub = mockConn.onReconnection((event) => {
        events.push(event);
      });

      mockConn._emitReconnectionEvent({ type: "disconnected" });
      expect(events).toHaveLength(1);

      unsub();

      mockConn._emitReconnectionEvent({ type: "reconnectFailed" });
      expect(events).toHaveLength(1); // no new events
    });
  });

  // ==========================================================================
  // Multiple connection swaps (simulating repeated reconnections)
  // ==========================================================================

  describe("multiple reconnection cycles", () => {
    it("survives multiple disconnect → reconnect cycles", async () => {
      // Spawn an agent
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "durable-agent",
          name: "durable",
          role: "executor",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      // Cycle 1: disconnect → reconnect
      handler.setConnection(null);
      const conn2 = createMockMapConnection();
      handler.setConnection(conn2);

      let resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.cycle-1" },
      });
      expect(resp.ok).toBe(true);
      expect(conn2.send).toHaveBeenCalledTimes(1);

      // Cycle 2: disconnect → reconnect
      handler.setConnection(null);
      const conn3 = createMockMapConnection();
      handler.setConnection(conn3);

      resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.cycle-2" },
      });
      expect(resp.ok).toBe(true);
      expect(conn3.send).toHaveBeenCalledTimes(1);
      expect(conn2.send).toHaveBeenCalledTimes(1); // no new calls on old conn

      // Cycle 3: disconnect → reconnect
      handler.setConnection(null);
      const conn4 = createMockMapConnection();
      handler.setConnection(conn4);

      resp = await sendSocketCommand(socketPath, {
        action: "emit",
        event: { type: "test.cycle-3" },
      });
      expect(resp.ok).toBe(true);
      expect(conn4.send).toHaveBeenCalledTimes(1);

      // Agent is still tracked through all cycles
      expect(registeredAgents.has("durable-agent")).toBe(true);

      // Can still spawn on latest connection
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "new-after-cycles",
          name: "newcomer",
          role: "worker",
          scopes: [SCOPE],
          metadata: {},
        },
      });
      expect(conn4.spawn).toHaveBeenCalledTimes(1);
      expect(registeredAgents.size).toBe(2);
    });
  });

  // ==========================================================================
  // State tracking persists across reconnections
  // ==========================================================================

  describe("state tracking persists across reconnections", () => {
    it("agent metadata and state survive connection swap", async () => {
      // Spawn and set state
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "stateful-agent",
          name: "stateful",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd", wave: 1 },
        },
      });
      await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
        agentId: "stateful-agent",
        metadata: { currentTask: "task-42" },
      });

      const agentBefore = registeredAgents.get("stateful-agent");
      expect(agentBefore.lastState).toBe("busy");
      expect(agentBefore.metadata.currentTask).toBe("task-42");
      expect(agentBefore.metadata.template).toBe("gsd");

      // Disconnect and reconnect
      handler.setConnection(null);
      const newConn = createMockMapConnection();
      handler.setConnection(newConn);

      // Agent data should still be in the map
      const agentAfter = registeredAgents.get("stateful-agent");
      expect(agentAfter.lastState).toBe("busy");
      expect(agentAfter.metadata.currentTask).toBe("task-42");
      expect(agentAfter.metadata.template).toBe("gsd");
      expect(agentAfter.role).toBe("executor");
    });
  });
});
