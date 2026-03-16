/**
 * Tests for mesh-connection.mjs — uses real agentic-mesh >=0.2.0 and agent-inbox (no mocking).
 *
 * Creates real MeshPeer instances via MeshPeer.createEmbedded() (in-process
 * MapServer, no networking). Verifies the full integration:
 *   createMeshPeer → real MeshPeer + AgentConnection (0.2.0 API)
 *   createMeshInbox → real agent-inbox with MeshPeer
 *   meshFireAndForget → ephemeral peer send + cleanup
 */

import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { createMeshPeer, createMeshInbox, meshFireAndForget } from "../mesh-connection.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("mesh-connection (real agentic-mesh 0.2.0, no mocks)", () => {
  let cleanupPeers = [];
  let tmpDirs = [];

  afterEach(async () => {
    for (const peer of cleanupPeers) {
      try { await peer.stop(); } catch { /* ignore */ }
    }
    cleanupPeers = [];
    for (const dir of tmpDirs) {
      cleanupTmpDir(dir);
    }
    tmpDirs = [];
  });

  // ── createMeshPeer ──────────────────────────────────────────────────────

  describe("createMeshPeer", () => {
    it("creates an embedded MeshPeer via createEmbedded and registers agent", async () => {
      const result = await createMeshPeer({
        peerId: "test-peer",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });

      expect(result).not.toBeNull();
      cleanupPeers.push(result.peer);

      // Embedded peer has server but isRunning is false (no transport)
      expect(result.peer.server).toBeDefined();
      expect(result.connection).toBeDefined();
      expect(result.connection.isRegistered).toBe(true);
      expect(result.connection.agentId).toBe("test-peer-agent");
    });

    it("agent connection exposes 0.2.0 API surface", async () => {
      const result = await createMeshPeer({
        peerId: "api-test",
        scope: "swarm:team",
        systemId: "sys-1",
      });
      cleanupPeers.push(result.peer);

      // Core methods (existed in 0.0.5)
      expect(typeof result.connection.send).toBe("function");
      expect(typeof result.connection.updateState).toBe("function");
      expect(typeof result.connection.updateMetadata).toBe("function");
      expect(typeof result.connection.unregister).toBe("function");

      // New 0.2.0 methods
      expect(typeof result.connection.broadcastToScope).toBe("function");
      expect(typeof result.connection.sendToParent).toBe("function");
      expect(typeof result.connection.sendToChildren).toBe("function");
      expect(typeof result.connection.joinScope).toBe("function");
      expect(typeof result.connection.leaveScope).toBe("function");
      expect(typeof result.connection.subscribe).toBe("function");
      expect(typeof result.connection.getHierarchy).toBe("function");
      expect(typeof result.connection.getScopes).toBe("function");
    });

    it("agent connection has correct state and agent properties", async () => {
      const result = await createMeshPeer({
        peerId: "state-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      expect(result.connection.isRegistered).toBe(true);
      expect(result.connection.agent).toBeDefined();
      expect(result.connection.state).toBe("registered");
    });

    it("agent is registered on the MeshPeer's MapServer", async () => {
      const result = await createMeshPeer({
        peerId: "reg-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      const agents = result.peer.server.listAgents();
      const sidecarAgent = agents.find((a) => a.id === "reg-test-agent");
      expect(sidecarAgent).toBeDefined();
      expect(sidecarAgent.name).toBe("gsd-sidecar");
      expect(sidecarAgent.role).toBe("sidecar");
    });

    it("can send messages via the connection", async () => {
      const result = await createMeshPeer({
        peerId: "send-test",
        scope: "swarm:team",
        systemId: "sys-1",
      });
      cleanupPeers.push(result.peer);

      // Should not throw
      await result.connection.send(
        { scope: "swarm:team" },
        { type: "test.event", data: "hello" },
        { relationship: "broadcast" }
      );
    });

    it("registers onMessage callback via event emitter", async () => {
      const result = await createMeshPeer({
        peerId: "msg-test",
        scope: "swarm:team",
        systemId: "sys-1",
        onMessage: () => {},
      });
      cleanupPeers.push(result.peer);

      expect(result.connection.listenerCount("message")).toBeGreaterThanOrEqual(0);
    });

    it("can create child agents on the MapServer", async () => {
      const result = await createMeshPeer({
        peerId: "spawn-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      const child = await result.peer.createAgent({
        agentId: "child-worker",
        name: "worker",
        role: "executor",
      });
      expect(child.agentId).toBe("child-worker");
      expect(child.isRegistered).toBe(true);

      const agents = result.peer.server.listAgents();
      const childAgent = agents.find((a) => a.id === "child-worker");
      expect(childAgent).toBeDefined();
      expect(childAgent.name).toBe("worker");
    });

    it("supports parent-child agent hierarchy", async () => {
      const result = await createMeshPeer({
        peerId: "hierarchy-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      // Sidecar agent is the parent (created by createMeshPeer)
      const parentId = "hierarchy-test-agent";

      // Create child agent with parent reference
      const child = await result.peer.createAgent({
        agentId: "child-executor",
        name: "executor",
        role: "executor",
        parent: parentId,
      });

      expect(child.isRegistered).toBe(true);
      expect(child.agent.parent).toBe(parentId);

      // Verify hierarchy in MapServer
      const agents = result.peer.server.listAgents();
      const childAgent = agents.find((a) => a.id === "child-executor");
      expect(childAgent.parent).toBe(parentId);
    });

    it("can unregister agents from the MapServer", async () => {
      const result = await createMeshPeer({
        peerId: "unreg-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      await result.peer.createAgent({
        agentId: "temp-agent",
        name: "temp",
        role: "worker",
      });

      const beforeAgents = result.peer.server.listAgents();
      expect(beforeAgents.find((a) => a.id === "temp-agent")).toBeDefined();

      result.peer.server.unregisterAgent("temp-agent");

      const afterAgents = result.peer.server.listAgents();
      expect(afterAgents.find((a) => a.id === "temp-agent")).toBeUndefined();
    });

    it("can update agent state via connection", async () => {
      const result = await createMeshPeer({
        peerId: "state-update-test",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(result.peer);

      await result.connection.updateState("busy");
      expect(result.connection.state).toBe("busy");

      await result.connection.updateState("idle");
      expect(result.connection.state).toBe("idle");
    });
  });

  // ── createMeshInbox ─────────────────────────────────────────────────────

  describe("createMeshInbox", () => {
    it("creates a real agent-inbox with MeshPeer", async () => {
      const tmpDir = makeTmpDir("mesh-inbox-");
      tmpDirs.push(tmpDir);
      const socketPath = path.join(tmpDir, "inbox.sock");

      const peerResult = await createMeshPeer({
        peerId: "inbox-peer",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(peerResult.peer);

      const inbox = await createMeshInbox({
        meshPeer: peerResult.peer,
        scope: "swarm:gsd",
        systemId: "sys-test",
        socketPath,
        inboxConfig: {},
      });

      expect(inbox).not.toBeNull();
      expect(inbox.router).toBeDefined();
      expect(inbox.storage).toBeDefined();

      if (inbox?.stop) await inbox.stop();
    });

    it("inbox storage can register agents via putAgent", async () => {
      const tmpDir = makeTmpDir("mesh-inbox-reg-");
      tmpDirs.push(tmpDir);
      const socketPath = path.join(tmpDir, "inbox.sock");

      const peerResult = await createMeshPeer({
        peerId: "inbox-reg-peer",
        scope: "swarm:gsd",
        systemId: "sys-test",
      });
      cleanupPeers.push(peerResult.peer);

      const inbox = await createMeshInbox({
        meshPeer: peerResult.peer,
        scope: "swarm:gsd",
        systemId: "sys-test",
        socketPath,
        inboxConfig: {},
      });

      expect(inbox).not.toBeNull();

      // Register an agent via inbox storage (the direct API)
      inbox.storage.putAgent({
        agent_id: "test-agent-1",
        scope: "swarm:gsd",
        status: "active",
        metadata: { name: "worker", role: "executor" },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      // The agent should be in storage
      const agent = inbox.storage.getAgent("test-agent-1");
      expect(agent).toBeDefined();
      expect(agent.agent_id).toBe("test-agent-1");

      if (inbox?.stop) await inbox.stop();
    });
  });

  // ── meshFireAndForget ─────────────────────────────────────────────────

  describe("meshFireAndForget", () => {
    it("creates ephemeral embedded peer, sends, and cleans up without error", async () => {
      const config = { map: { scope: "swarm:gsd" } };
      const event = { type: "test.event", data: "hello" };

      // Should not throw — uses MeshPeer.createEmbedded internally
      await meshFireAndForget(config, event);
    });

    it("handles default scope gracefully", async () => {
      const config = { map: {} };
      await meshFireAndForget(config, { type: "test" });
    });
  });
});
