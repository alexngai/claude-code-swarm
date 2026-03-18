/**
 * E2E tests: Real agent-inbox IPC server + sidecar command handler
 *
 * Tests the full inbox pipeline with NO mocks on the inbox layer:
 *   Sidecar spawn → real inbox storage registration →
 *   IPC send → real message routing → IPC check_inbox → real inbox query →
 *   IPC read_thread → real thread retrieval → IPC list_agents → real agent list
 *
 * Uses:
 * - Real UNIX socket server (sidecar lifecycle socket)
 * - Real agent-inbox IpcServer (inbox IPC socket) with InMemoryStorage + MessageRouter
 * - Real sidecar command handler with inboxInstance wired to live inbox
 *
 * Verifies results by querying the inbox IPC server directly and inspecting
 * real storage state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { EventEmitter } from "events";
import { InMemoryStorage, MessageRouter, IpcServer } from "agent-inbox";
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
    }, 3000);
  });
}

/**
 * Send an IPC command to the agent-inbox IPC server.
 */
function sendInboxCommand(socketPath, command) {
  return sendSocketCommand(socketPath, command);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: sidecar + real agent-inbox IPC server (live inbox)", () => {
  let tmpDir;
  let sidecarSocketPath;
  let inboxSocketPath;
  let sidecarServer;
  let mockConn;
  let registeredAgents;

  // Real agent-inbox components
  let inboxStorage;
  let inboxEvents;
  let inboxRouter;
  let inboxIpcServer;

  const SCOPE = "swarm:live-inbox";

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-live-inbox-");
    sidecarSocketPath = path.join(tmpDir, "sidecar.sock");
    inboxSocketPath = path.join(tmpDir, "inbox.sock");

    // Create real agent-inbox stack
    inboxStorage = new InMemoryStorage();
    inboxEvents = new EventEmitter();
    inboxRouter = new MessageRouter(inboxStorage, inboxEvents, SCOPE);
    inboxIpcServer = new IpcServer(inboxSocketPath, inboxRouter, inboxStorage);
    await inboxIpcServer.start();

    // Create mock MAP connection (we're testing inbox, not MAP)
    mockConn = createMockMapConnection();
    registeredAgents = new Map();

    // Create sidecar with real inbox instance
    const inboxInstance = {
      storage: inboxStorage,
      events: inboxEvents,
      router: inboxRouter,
      ipcServer: inboxIpcServer,
    };

    const handler = createCommandHandler(mockConn, SCOPE, registeredAgents, {
      inboxInstance,
      transportMode: "websocket",
    });
    sidecarServer = createSocketServer(sidecarSocketPath, handler);
    await new Promise((resolve) => sidecarServer.on("listening", resolve));
  });

  afterEach(async () => {
    if (sidecarServer) {
      await new Promise((resolve) => sidecarServer.close(resolve));
      sidecarServer = null;
    }
    if (inboxIpcServer) {
      await inboxIpcServer.stop();
      inboxIpcServer = null;
    }
    cleanupTmpDir(tmpDir);
  });

  // ==========================================================================
  // Spawn registers agent in real inbox storage, visible via IPC
  // ==========================================================================

  describe("spawn → real inbox storage → IPC list_agents", () => {
    it("agent spawned via sidecar is visible via inbox IPC list_agents", async () => {
      // Spawn agent via sidecar
      const spawnResp = await sendSocketCommand(sidecarSocketPath, {
        action: "spawn",
        agent: {
          agentId: "gsd-executor",
          name: "executor",
          role: "executor",
          scopes: [SCOPE],
          metadata: { template: "gsd" },
        },
      });
      expect(spawnResp.ok).toBe(true);

      // Verify agent is visible via real inbox IPC
      const listResp = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      expect(listResp.ok).toBe(true);
      expect(listResp.count).toBeGreaterThanOrEqual(1);

      const agents = listResp.agents;
      const executor = agents.find((a) => a.agentId === "gsd-executor");
      expect(executor).toBeDefined();
      expect(executor.status).toBe("active");
    });

    it("multiple agents spawned via sidecar all visible via inbox IPC", async () => {
      const roles = ["lead", "executor", "verifier"];

      for (const role of roles) {
        await sendSocketCommand(sidecarSocketPath, {
          action: "spawn",
          agent: {
            agentId: `gsd-${role}`,
            name: role,
            role,
            scopes: [SCOPE],
            metadata: {},
          },
        });
      }

      const listResp = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      expect(listResp.ok).toBe(true);
      expect(listResp.count).toBeGreaterThanOrEqual(3);

      const ids = listResp.agents.map((a) => a.agentId);
      expect(ids).toContain("gsd-lead");
      expect(ids).toContain("gsd-executor");
      expect(ids).toContain("gsd-verifier");
    });
  });

  // ==========================================================================
  // Send message via IPC → check_inbox via IPC
  // ==========================================================================

  describe("IPC send → IPC check_inbox (real message routing)", () => {
    it("message sent via inbox IPC is received by target agent", async () => {
      // Send a message to gsd-executor via real inbox IPC
      const sendResp = await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-executor",
        payload: "Please start task #42",
      });
      expect(sendResp.ok).toBe(true);
      expect(sendResp.messageId).toBeTruthy();

      // Check inbox for gsd-executor via real inbox IPC
      const checkResp = await sendInboxCommand(inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-executor",
      });
      expect(checkResp.ok).toBe(true);
      expect(checkResp.messages).toHaveLength(1);
      expect(checkResp.messages[0].sender_id).toBe("gsd-lead");
    });

    it("message sent to agent A is NOT visible in agent B inbox", async () => {
      // Send to executor
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-executor",
        payload: "For executor only",
      });

      // Check inbox for verifier — should be empty
      const checkResp = await sendInboxCommand(inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-verifier",
      });
      expect(checkResp.ok).toBe(true);
      expect(checkResp.messages).toHaveLength(0);
    });

    it("multiple messages to same agent are all received", async () => {
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-worker",
        payload: "Task 1",
      });
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-worker",
        payload: "Task 2",
      });
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-verifier",
        to: "gsd-worker",
        payload: "Review result",
      });

      const checkResp = await sendInboxCommand(inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-worker",
      });
      expect(checkResp.ok).toBe(true);
      expect(checkResp.messages).toHaveLength(3);

      const senders = checkResp.messages.map((m) => m.sender_id);
      expect(senders).toContain("gsd-lead");
      expect(senders).toContain("gsd-verifier");
    });
  });

  // ==========================================================================
  // Threaded conversations via IPC
  // ==========================================================================

  describe("IPC send with threadTag → IPC read_thread (real threading)", () => {
    it("messages with same threadTag form a readable thread", async () => {
      // Agent A sends to Agent B with threadTag
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-executor",
        payload: "Start working on feature X",
        threadTag: "feature-x",
      });

      // Agent B replies with same threadTag
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-executor",
        to: "gsd-lead",
        payload: "Working on it now",
        threadTag: "feature-x",
      });

      // Agent B sends another update
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-executor",
        to: "gsd-lead",
        payload: "Feature X is done",
        threadTag: "feature-x",
      });

      // Read the full thread
      const threadResp = await sendInboxCommand(inboxSocketPath, {
        action: "read_thread",
        threadTag: "feature-x",
        scope: SCOPE,
      });
      expect(threadResp.ok).toBe(true);
      expect(threadResp.count).toBe(3);
      expect(threadResp.threadTag).toBe("feature-x");

      const senders = threadResp.messages.map((m) => m.sender_id);
      expect(senders[0]).toBe("gsd-lead");
      expect(senders[1]).toBe("gsd-executor");
      expect(senders[2]).toBe("gsd-executor");
    });

    it("different threads are isolated", async () => {
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "alice",
        to: "bob",
        payload: "Thread A message",
        threadTag: "thread-a",
      });

      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "charlie",
        to: "dave",
        payload: "Thread B message",
        threadTag: "thread-b",
      });

      const threadA = await sendInboxCommand(inboxSocketPath, {
        action: "read_thread",
        threadTag: "thread-a",
        scope: SCOPE,
      });
      expect(threadA.count).toBe(1);
      expect(threadA.messages[0].sender_id).toBe("alice");

      const threadB = await sendInboxCommand(inboxSocketPath, {
        action: "read_thread",
        threadTag: "thread-b",
        scope: SCOPE,
      });
      expect(threadB.count).toBe(1);
      expect(threadB.messages[0].sender_id).toBe("charlie");
    });
  });

  // ==========================================================================
  // Agent done → deregistration visible via IPC
  // ==========================================================================

  describe("done → inbox deregistration visible via IPC", () => {
    it("agent marked done via sidecar shows disconnected in inbox list_agents", async () => {
      // Spawn
      await sendSocketCommand(sidecarSocketPath, {
        action: "spawn",
        agent: {
          agentId: "temp-agent",
          name: "temp",
          role: "temp",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      // Verify active
      let listResp = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      const before = listResp.agents.find((a) => a.agentId === "temp-agent");
      expect(before).toBeDefined();
      expect(before.status).toBe("active");

      // Done via sidecar
      await sendSocketCommand(sidecarSocketPath, {
        action: "done",
        agentId: "temp-agent",
        reason: "completed",
      });

      // Verify disconnected in inbox
      listResp = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      const after = listResp.agents.find((a) => a.agentId === "temp-agent");
      expect(after).toBeDefined();
      expect(after.status).toBe("disconnected");
    });
  });

  // ==========================================================================
  // message.created event fires on real inbox send
  // ==========================================================================

  describe("message.created event on real inbox send", () => {
    it("inbox events emitter fires message.created when a message is sent via IPC", async () => {
      const received = [];
      inboxEvents.on("message.created", (msg) => {
        received.push(msg);
      });

      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-executor",
        payload: "event test message",
      });

      // Give the event a tick
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(1);
      expect(received[0].sender_id).toBe("gsd-lead");
    });

    it("message.created event bridges to MAP when wired up", async () => {
      // Wire up the bridge like map-sidecar.mjs does
      inboxEvents.on("message.created", (message) => {
        mockConn.send({ scope: SCOPE }, {
          type: "inbox.message",
          messageId: message.id,
          from: message.sender_id,
          to: (message.recipients || []).map((r) => r.agent_id),
          threadTag: message.thread_tag,
        }, { relationship: "broadcast" }).catch(() => {});
      });

      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "gsd-executor",
        to: "gsd-verifier",
        payload: "Please verify",
        threadTag: "task-99",
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockConn.send).toHaveBeenCalledOnce();
      const [target, payload, meta] = mockConn.send.mock.calls[0];
      expect(target.scope).toBe(SCOPE);
      expect(payload.type).toBe("inbox.message");
      expect(payload.from).toBe("gsd-executor");
      expect(payload.to).toContain("gsd-verifier");
      expect(payload.threadTag).toBe("task-99");
      expect(meta.relationship).toBe("broadcast");
    });
  });

  // ==========================================================================
  // Agent notify (spawn event) via inbox IPC
  // ==========================================================================

  describe("agent notify via inbox IPC (alternative to sidecar spawn)", () => {
    it("agent registered via inbox notify is visible in list_agents", async () => {
      // Register via inbox IPC notify (how bootstrap.mjs registers main agent)
      const notifyResp = await sendInboxCommand(inboxSocketPath, {
        action: "notify",
        event: {
          type: "agent.spawn",
          agent: {
            agentId: "gsd-main",
            name: "gsd-main",
            role: "orchestrator",
            scopes: [SCOPE],
            metadata: { isMain: true },
          },
        },
      });
      expect(notifyResp.ok).toBe(true);

      const listResp = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      const mainAgent = listResp.agents.find((a) => a.agentId === "gsd-main");
      expect(mainAgent).toBeDefined();
    });
  });

  // ==========================================================================
  // Full flow: spawn agents → exchange messages → read threads → done
  // ==========================================================================

  describe("full flow: spawn → messages → threads → done", () => {
    it("complete agent messaging lifecycle via real inbox", async () => {
      // 1. Spawn lead and executor via sidecar
      await sendSocketCommand(sidecarSocketPath, {
        action: "spawn",
        agent: {
          agentId: "flow-lead",
          name: "lead",
          role: "lead",
          scopes: [SCOPE],
          metadata: {},
        },
      });
      await sendSocketCommand(sidecarSocketPath, {
        action: "spawn",
        agent: {
          agentId: "flow-executor",
          name: "executor",
          role: "executor",
          scopes: [SCOPE],
          metadata: {},
        },
      });

      // Verify both registered in inbox
      const agents = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      expect(agents.count).toBeGreaterThanOrEqual(2);

      // 2. Lead assigns task via threaded message
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "flow-lead",
        to: "flow-executor",
        payload: "Implement user auth module",
        threadTag: "task-auth",
      });

      // 3. Executor checks inbox
      const executorInbox = await sendInboxCommand(inboxSocketPath, {
        action: "check_inbox",
        agentId: "flow-executor",
      });
      expect(executorInbox.messages).toHaveLength(1);
      expect(executorInbox.messages[0].sender_id).toBe("flow-lead");

      // 4. Executor replies
      await sendInboxCommand(inboxSocketPath, {
        action: "send",
        from: "flow-executor",
        to: "flow-lead",
        payload: "Auth module implemented, ready for review",
        threadTag: "task-auth",
      });

      // 5. Lead checks inbox
      const leadInbox = await sendInboxCommand(inboxSocketPath, {
        action: "check_inbox",
        agentId: "flow-lead",
      });
      expect(leadInbox.messages).toHaveLength(1);
      expect(leadInbox.messages[0].sender_id).toBe("flow-executor");

      // 6. Read full thread
      const thread = await sendInboxCommand(inboxSocketPath, {
        action: "read_thread",
        threadTag: "task-auth",
        scope: SCOPE,
      });
      expect(thread.count).toBe(2);
      expect(thread.messages[0].sender_id).toBe("flow-lead");
      expect(thread.messages[1].sender_id).toBe("flow-executor");

      // 7. Done via sidecar
      await sendSocketCommand(sidecarSocketPath, {
        action: "done",
        agentId: "flow-executor",
        reason: "completed",
      });
      await sendSocketCommand(sidecarSocketPath, {
        action: "done",
        agentId: "flow-lead",
        reason: "completed",
      });

      // 8. Verify deregistered
      const finalAgents = await sendInboxCommand(inboxSocketPath, {
        action: "list_agents",
      });
      const flowLead = finalAgents.agents.find((a) => a.agentId === "flow-lead");
      const flowExec = finalAgents.agents.find((a) => a.agentId === "flow-executor");
      expect(flowLead.status).toBe("disconnected");
      expect(flowExec.status).toBe("disconnected");

      // 9. Thread is still readable after agents are done
      const threadAfter = await sendInboxCommand(inboxSocketPath, {
        action: "read_thread",
        threadTag: "task-auth",
        scope: SCOPE,
      });
      expect(threadAfter.count).toBe(2);
    });
  });
});
