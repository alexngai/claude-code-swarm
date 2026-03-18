/**
 * E2E tests: Inbox integration — real sidecar socket + mock inbox storage
 *
 * Tests the full inbox pipeline:
 *   Agent spawn → inbox registration → message send → check_inbox → threading
 *   Agent done → inbox deregistration
 *   message.created event → MAP outbound bridge
 *
 * Uses real UNIX socket server (no mocking of socket layer).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { EventEmitter } from "events";
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
 * Create a mock inbox instance with in-memory agent storage and event emitter.
 */
function createMockInboxInstance() {
  const agents = new Map();
  const events = new EventEmitter();

  return {
    storage: {
      putAgent: vi.fn((agent) => {
        agents.set(agent.agent_id, agent);
      }),
      getAgent: (agentId) => agents.get(agentId),
      listAgents: (scope) => {
        const all = [...agents.values()];
        return scope ? all.filter((a) => a.scope === scope) : all;
      },
    },
    events,
    _agents: agents,
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
      try { resolve(JSON.parse(data.trim().split("\n").pop())); }
      catch { reject(new Error("Timeout waiting for response")); }
    }, 2000);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: inbox integration — websocket mode with inbox storage", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let mockInbox;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-inbox-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    mockInbox = createMockInboxInstance();
    registeredAgents = new Map();

    const handler = createCommandHandler(mockConn, "swarm:inbox-test", registeredAgents, {
      inboxInstance: mockInbox,
      transportMode: "websocket",
    });
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
  // Agent spawn registers in inbox storage
  // ==========================================================================

  describe("agent spawn → inbox registration", () => {
    it("registers agent in inbox storage on spawn", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "inbox-test-executor",
          name: "executor",
          role: "executor",
          scopes: ["swarm:inbox-test"],
          metadata: { template: "gsd" },
        },
      });

      expect(resp.ok).toBe(true);

      // MAP SDK spawn should have been called (websocket mode)
      expect(mockConn.spawn).toHaveBeenCalledOnce();

      // Inbox storage should also have the agent
      expect(mockInbox.storage.putAgent).toHaveBeenCalledOnce();
      const storedAgent = mockInbox._agents.get("inbox-test-executor");
      expect(storedAgent).toBeDefined();
      expect(storedAgent.agent_id).toBe("inbox-test-executor");
      expect(storedAgent.status).toBe("active");
      expect(storedAgent.scope).toBe("swarm:inbox-test");
      expect(storedAgent.metadata.role).toBe("executor");
    });

    it("registers multiple agents in inbox storage", async () => {
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "inbox-test-lead",
          name: "lead",
          role: "lead",
          scopes: ["swarm:inbox-test"],
          metadata: {},
        },
      });

      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "inbox-test-worker",
          name: "worker",
          role: "worker",
          scopes: ["swarm:inbox-test"],
          metadata: {},
        },
      });

      expect(mockInbox._agents.size).toBe(2);
      expect(mockInbox._agents.has("inbox-test-lead")).toBe(true);
      expect(mockInbox._agents.has("inbox-test-worker")).toBe(true);
    });
  });

  // ==========================================================================
  // Agent done deregisters from inbox storage
  // ==========================================================================

  describe("agent done → inbox deregistration", () => {
    it("marks agent disconnected in inbox storage on done", async () => {
      // First spawn
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "inbox-test-temp",
          name: "temp",
          role: "worker",
          scopes: ["swarm:inbox-test"],
          metadata: {},
        },
      });

      expect(mockInbox._agents.get("inbox-test-temp").status).toBe("active");

      // Then done
      const resp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "inbox-test-temp",
        reason: "completed",
      });

      expect(resp.ok).toBe(true);

      // Inbox storage should show disconnected
      const storedAgent = mockInbox._agents.get("inbox-test-temp");
      expect(storedAgent.status).toBe("disconnected");

      // Registered agents map should not have it
      expect(registeredAgents.has("inbox-test-temp")).toBe(false);

      // MAP unregister should have been called
      expect(mockConn.callExtension).toHaveBeenCalledWith(
        "map/agents/unregister",
        { agentId: "inbox-test-temp", reason: "completed" },
      );
    });
  });

  // ==========================================================================
  // Full agent lifecycle with inbox
  // ==========================================================================

  describe("full agent lifecycle with inbox", () => {
    it("spawn → state → done: inbox tracks all states", async () => {
      // Spawn
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "lifecycle-agent",
          name: "lifecycle",
          role: "executor",
          scopes: ["swarm:inbox-test"],
          metadata: { template: "gsd" },
        },
      });

      expect(mockInbox._agents.get("lifecycle-agent").status).toBe("active");
      expect(registeredAgents.has("lifecycle-agent")).toBe(true);

      // State update (doesn't touch inbox storage directly, just registeredAgents)
      await sendSocketCommand(socketPath, {
        action: "state",
        state: "busy",
        agentId: "lifecycle-agent",
      });

      expect(registeredAgents.get("lifecycle-agent").lastState).toBe("busy");

      // Done
      await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "lifecycle-agent",
        reason: "completed",
      });

      expect(mockInbox._agents.get("lifecycle-agent").status).toBe("disconnected");
      expect(registeredAgents.has("lifecycle-agent")).toBe(false);
    });
  });
});

describe("E2E: inbox integration — mesh mode with inbox storage", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let mockInbox;
  let mockMeshPeer;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-inbox-mesh-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    mockInbox = createMockInboxInstance();
    mockMeshPeer = {
      createAgent: vi.fn().mockResolvedValue(undefined),
      server: {
        unregisterAgent: vi.fn(),
      },
    };
    registeredAgents = new Map();

    const handler = createCommandHandler(mockConn, "swarm:mesh-test", registeredAgents, {
      inboxInstance: mockInbox,
      meshPeer: mockMeshPeer,
      transportMode: "mesh",
    });
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

  describe("mesh spawn uses inbox registry instead of MAP SDK", () => {
    it("registers in inbox storage and MeshPeer, not MAP SDK", async () => {
      const resp = await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "mesh-executor",
          name: "executor",
          role: "executor",
          scopes: ["swarm:mesh-test"],
          metadata: { template: "gsd" },
        },
      });

      expect(resp.ok).toBe(true);

      // MAP SDK spawn should NOT be called in mesh mode
      expect(mockConn.spawn).not.toHaveBeenCalled();

      // Inbox storage should have the agent
      expect(mockInbox.storage.putAgent).toHaveBeenCalledOnce();
      const stored = mockInbox._agents.get("mesh-executor");
      expect(stored.status).toBe("active");
      expect(stored.scope).toBe("swarm:mesh-test");

      // MeshPeer.createAgent should be called for observability
      expect(mockMeshPeer.createAgent).toHaveBeenCalledWith({
        agentId: "mesh-executor",
        name: "executor",
        role: "executor",
        metadata: { template: "gsd" },
      });

      // registeredAgents should track it
      expect(registeredAgents.has("mesh-executor")).toBe(true);
    });
  });

  describe("mesh done uses inbox registry instead of MAP SDK", () => {
    it("deregisters from inbox storage and MeshPeer, not MAP SDK", async () => {
      // Spawn first
      await sendSocketCommand(socketPath, {
        action: "spawn",
        agent: {
          agentId: "mesh-worker",
          name: "worker",
          role: "worker",
          scopes: ["swarm:mesh-test"],
          metadata: {},
        },
      });

      // Done
      const resp = await sendSocketCommand(socketPath, {
        action: "done",
        agentId: "mesh-worker",
        reason: "completed",
      });

      expect(resp.ok).toBe(true);

      // MAP SDK unregister should NOT be called in mesh mode
      expect(mockConn.callExtension).not.toHaveBeenCalled();

      // Inbox storage should show disconnected
      expect(mockInbox._agents.get("mesh-worker").status).toBe("disconnected");

      // MeshPeer.server.unregisterAgent should be called
      expect(mockMeshPeer.server.unregisterAgent).toHaveBeenCalledWith("mesh-worker");

      // registeredAgents should not have it
      expect(registeredAgents.has("mesh-worker")).toBe(false);
    });
  });
});

describe("E2E: inbox integration — message.created event → MAP bridge", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let mockInbox;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-inbox-events-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    mockInbox = createMockInboxInstance();
    registeredAgents = new Map();

    const handler = createCommandHandler(mockConn, "swarm:event-test", registeredAgents, {
      inboxInstance: mockInbox,
      transportMode: "websocket",
    });
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

  it("emits inbox.message MAP event when message.created is fired", async () => {
    // Simulate what map-sidecar.mjs does: subscribe to message.created events
    // and bridge them to MAP
    mockInbox.events.on("message.created", (message) => {
      mockConn.send({ scope: "swarm:event-test" }, {
        type: "inbox.message",
        messageId: message.id,
        from: message.sender_id,
        to: (message.recipients || []).map((r) => r.agent_id),
        contentType: message.content?.type || "text",
        threadTag: message.thread_tag,
        importance: message.importance,
      }, { relationship: "broadcast" }).catch(() => {});
    });

    // Fire a message.created event (simulates inbox processing a send)
    mockInbox.events.emit("message.created", {
      id: "msg-001",
      sender_id: "gsd-executor",
      recipients: [{ agent_id: "gsd-verifier" }],
      content: { type: "text", body: "Verification needed" },
      thread_tag: "task-42",
      importance: "normal",
    });

    // Give the event handler a tick to process
    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.send).toHaveBeenCalledOnce();
    const [target, payload, meta] = mockConn.send.mock.calls[0];
    expect(target).toEqual({ scope: "swarm:event-test" });
    expect(payload.type).toBe("inbox.message");
    expect(payload.messageId).toBe("msg-001");
    expect(payload.from).toBe("gsd-executor");
    expect(payload.to).toEqual(["gsd-verifier"]);
    expect(payload.threadTag).toBe("task-42");
    expect(meta.relationship).toBe("broadcast");
  });

  it("bridges multiple messages with correct sender/recipient", async () => {
    // Set up the bridge listener
    mockInbox.events.on("message.created", (message) => {
      mockConn.send({ scope: "swarm:event-test" }, {
        type: "inbox.message",
        messageId: message.id,
        from: message.sender_id,
        to: (message.recipients || []).map((r) => r.agent_id),
        contentType: message.content?.type || "text",
        threadTag: message.thread_tag,
      }, { relationship: "broadcast" }).catch(() => {});
    });

    // Agent A → Agent B
    mockInbox.events.emit("message.created", {
      id: "msg-010",
      sender_id: "gsd-lead",
      recipients: [{ agent_id: "gsd-executor" }],
      content: { type: "text", body: "Start task X" },
      thread_tag: "task-x",
    });

    // Agent B → Agent A (reply)
    mockInbox.events.emit("message.created", {
      id: "msg-011",
      sender_id: "gsd-executor",
      recipients: [{ agent_id: "gsd-lead" }],
      content: { type: "text", body: "Task X done" },
      thread_tag: "task-x",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockConn.send).toHaveBeenCalledTimes(2);

    const firstPayload = mockConn.send.mock.calls[0][1];
    expect(firstPayload.from).toBe("gsd-lead");
    expect(firstPayload.to).toEqual(["gsd-executor"]);
    expect(firstPayload.threadTag).toBe("task-x");

    const secondPayload = mockConn.send.mock.calls[1][1];
    expect(secondPayload.from).toBe("gsd-executor");
    expect(secondPayload.to).toEqual(["gsd-lead"]);
    expect(secondPayload.threadTag).toBe("task-x");
  });
});

describe("E2E: inbox integration — no inbox instance (graceful degradation)", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-inbox-none-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    registeredAgents = new Map();

    // No inboxInstance provided — should degrade gracefully
    const handler = createCommandHandler(mockConn, "swarm:no-inbox", registeredAgents, {
      transportMode: "websocket",
    });
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

  it("spawn works without inbox instance", async () => {
    const resp = await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "no-inbox-agent",
        name: "worker",
        role: "worker",
        scopes: ["swarm:no-inbox"],
        metadata: {},
      },
    });

    expect(resp.ok).toBe(true);
    expect(mockConn.spawn).toHaveBeenCalledOnce();
    expect(registeredAgents.has("no-inbox-agent")).toBe(true);
  });

  it("done works without inbox instance", async () => {
    // Spawn first
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "no-inbox-agent-2",
        name: "temp",
        role: "temp",
        scopes: ["swarm:no-inbox"],
        metadata: {},
      },
    });

    const resp = await sendSocketCommand(socketPath, {
      action: "done",
      agentId: "no-inbox-agent-2",
      reason: "completed",
    });

    expect(resp.ok).toBe(true);
    expect(mockConn.callExtension).toHaveBeenCalled();
    expect(registeredAgents.has("no-inbox-agent-2")).toBe(false);
  });
});

describe("E2E: inbox integration — mixed workflow with inbox + task bridge", () => {
  let tmpDir;
  let socketPath;
  let server;
  let mockConn;
  let mockInbox;
  let registeredAgents;

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-inbox-mixed-");
    socketPath = path.join(tmpDir, "sidecar.sock");
    mockConn = createMockMapConnection();
    mockInbox = createMockInboxInstance();
    registeredAgents = new Map();

    const handler = createCommandHandler(mockConn, "swarm:mixed-test", registeredAgents, {
      inboxInstance: mockInbox,
      transportMode: "websocket",
    });
    server = createSocketServer(socketPath, handler);
    await new Promise((resolve) => server.on("listening", resolve));

    // Set up message bridge (as map-sidecar.mjs does)
    mockInbox.events.on("message.created", (message) => {
      mockConn.send({ scope: "swarm:mixed-test" }, {
        type: "inbox.message",
        messageId: message.id,
        from: message.sender_id,
        to: (message.recipients || []).map((r) => r.agent_id),
        contentType: message.content?.type || "text",
        threadTag: message.thread_tag,
      }, { relationship: "broadcast" }).catch(() => {});
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    cleanupTmpDir(tmpDir);
  });

  it("full workflow: spawn agents → task create → message exchange → task complete → agents done", async () => {
    // 1. Spawn lead agent
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "mixed-lead",
        name: "lead",
        role: "lead",
        scopes: ["swarm:mixed-test"],
        metadata: { template: "gsd" },
      },
    });

    // 2. Spawn executor agent
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "mixed-executor",
        name: "executor",
        role: "executor",
        scopes: ["swarm:mixed-test"],
        metadata: { template: "gsd" },
      },
    });

    // Both agents registered in inbox
    expect(mockInbox._agents.size).toBe(2);
    expect(mockInbox._agents.get("mixed-lead").status).toBe("active");
    expect(mockInbox._agents.get("mixed-executor").status).toBe("active");

    // 3. Lead creates a task
    await sendSocketCommand(socketPath, {
      action: "bridge-task-created",
      task: { id: "mixed-task-1", title: "Implement feature", status: "open", assignee: "mixed-executor" },
      agentId: "mixed-lead",
    });

    // 4. Lead sends message to executor via inbox (simulated)
    mockInbox.events.emit("message.created", {
      id: "msg-mixed-1",
      sender_id: "mixed-lead",
      recipients: [{ agent_id: "mixed-executor" }],
      content: { type: "text", body: "Please start on mixed-task-1" },
      thread_tag: "mixed-task-1",
    });

    await new Promise((r) => setTimeout(r, 10));

    // 5. Executor starts working
    await sendSocketCommand(socketPath, {
      action: "bridge-task-status",
      taskId: "mixed-task-1",
      previous: "open",
      current: "in_progress",
      agentId: "mixed-executor",
    });

    // 6. Executor replies via inbox
    mockInbox.events.emit("message.created", {
      id: "msg-mixed-2",
      sender_id: "mixed-executor",
      recipients: [{ agent_id: "mixed-lead" }],
      content: { type: "text", body: "Task complete" },
      thread_tag: "mixed-task-1",
    });

    await new Promise((r) => setTimeout(r, 10));

    // 7. Task completed
    await sendSocketCommand(socketPath, {
      action: "bridge-task-status",
      taskId: "mixed-task-1",
      previous: "in_progress",
      current: "completed",
      agentId: "mixed-executor",
    });

    // 8. Agents done
    await sendSocketCommand(socketPath, {
      action: "done",
      agentId: "mixed-executor",
      reason: "completed",
    });
    await sendSocketCommand(socketPath, {
      action: "done",
      agentId: "mixed-lead",
      reason: "completed",
    });

    // Verify inbox states
    expect(mockInbox._agents.get("mixed-executor").status).toBe("disconnected");
    expect(mockInbox._agents.get("mixed-lead").status).toBe("disconnected");

    // Verify MAP calls:
    // - 2x spawn (MAP SDK in websocket mode)
    expect(mockConn.spawn).toHaveBeenCalledTimes(2);
    // - 2x callExtension for unregister
    expect(mockConn.callExtension).toHaveBeenCalledTimes(2);

    // MAP send calls:
    // task.created, inbox.message, task.status(in_progress), inbox.message, task.status(completed), task.completed
    const sendTypes = mockConn.send.mock.calls.map(([, p]) => p.type);
    expect(sendTypes).toEqual([
      "task.created",
      "inbox.message",
      "task.status",
      "inbox.message",
      "task.status",
      "task.completed",
    ]);

    // Verify inbox message payloads
    const inboxMessages = mockConn.send.mock.calls.filter(([, p]) => p.type === "inbox.message");
    expect(inboxMessages).toHaveLength(2);
    expect(inboxMessages[0][1].from).toBe("mixed-lead");
    expect(inboxMessages[0][1].to).toEqual(["mixed-executor"]);
    expect(inboxMessages[1][1].from).toBe("mixed-executor");
    expect(inboxMessages[1][1].to).toEqual(["mixed-lead"]);

    // Both messages share the same thread
    expect(inboxMessages[0][1].threadTag).toBe("mixed-task-1");
    expect(inboxMessages[1][1].threadTag).toBe("mixed-task-1");
  });
});
