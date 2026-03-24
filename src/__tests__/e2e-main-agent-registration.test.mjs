/**
 * E2E test: Main agent registration on bootstrap
 *
 * Verifies that when the sidecar starts successfully, the bootstrap
 * sends a spawn command to register the main Claude Code session agent.
 *
 * Uses a real TestServer + AgentConnection (no mocks on MAP layer).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import { createStreamPair, AgentConnection } from "@multi-agent-protocol/sdk";
import { TestServer } from "@multi-agent-protocol/sdk/testing";
import { createSocketServer, createCommandHandler } from "../sidecar-server.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

describe("Main agent registration via spawn", () => {
  let tmpDir;
  let socketPath;
  let socketServer;
  let mapServer;
  let conn;
  let registeredAgents;

  const SCOPE = "swarm:test-team";
  const SESSION_ID = "test-session-abc-123";

  beforeEach(async () => {
    tmpDir = makeTmpDir("e2e-main-agent-");
    socketPath = path.join(tmpDir, "sidecar.sock");

    const live = await createLiveMapConnection("test-team-sidecar");
    mapServer = live.server;
    conn = live.conn;

    registeredAgents = new Map();
    const handler = createCommandHandler(conn, SCOPE, registeredAgents);
    socketServer = createSocketServer(socketPath, handler);
    await new Promise((resolve) => socketServer.on("listening", resolve));
  });

  afterEach(async () => {
    if (socketServer) {
      await new Promise((resolve) => socketServer.close(resolve));
      socketServer = null;
    }
    if (conn && conn.isConnected) {
      try { await conn.disconnect(); } catch { /* ignore */ }
    }
    cleanupTmpDir(tmpDir);
  });

  it("registers main agent with sessionId as agentId", async () => {
    // This is the exact command bootstrap sends after sidecar starts
    const resp = await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: SESSION_ID,
        name: "test-team-main",
        role: "orchestrator",
        scopes: [SCOPE],
        metadata: { isMain: true, sessionId: SESSION_ID },
      },
    });

    expect(resp.ok).toBe(true);
    expect(resp.agent?.agent?.id).toBe(SESSION_ID);

    // Verify in TestServer
    const mainAgent = mapServer.agents.get(SESSION_ID);
    expect(mainAgent).toBeDefined();
    expect(mainAgent.name).toBe("test-team-main");
    expect(mainAgent.role).toBe("orchestrator");

    // Verify in local tracking
    expect(registeredAgents.has(SESSION_ID)).toBe(true);
    expect(registeredAgents.get(SESSION_ID).role).toBe("orchestrator");
    expect(registeredAgents.get(SESSION_ID).metadata.isMain).toBe(true);
  });

  it("main agent coexists with spawned subagents", async () => {
    // Register main agent
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: SESSION_ID,
        name: "test-team-main",
        role: "orchestrator",
        scopes: [SCOPE],
        metadata: { isMain: true, sessionId: SESSION_ID },
      },
    });

    // Spawn a subagent (like SubagentStart hook would)
    const subResp = await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "subagent-xyz-456",
        name: "Explore",
        role: "subagent",
        scopes: [SCOPE],
        metadata: { agentType: "Explore", sessionId: "subagent-xyz-456" },
      },
    });

    expect(subResp.ok).toBe(true);

    // Both should exist in TestServer
    expect(mapServer.agents.has(SESSION_ID)).toBe(true);
    expect(mapServer.agents.has("subagent-xyz-456")).toBe(true);

    // Both in local tracking
    expect(registeredAgents.size).toBe(2);
    expect(registeredAgents.get(SESSION_ID).role).toBe("orchestrator");
    expect(registeredAgents.get("subagent-xyz-456").role).toBe("subagent");
  });

  it("main agent survives subagent lifecycle", async () => {
    // Register main
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: SESSION_ID,
        name: "test-team-main",
        role: "orchestrator",
        scopes: [SCOPE],
        metadata: { isMain: true, sessionId: SESSION_ID },
      },
    });

    // Spawn and kill a subagent
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: "ephemeral-sub",
        name: "Explore",
        role: "subagent",
        scopes: [SCOPE],
        metadata: {},
      },
    });

    await sendSocketCommand(socketPath, {
      action: "done",
      agentId: "ephemeral-sub",
      reason: "completed",
    });

    // Main agent should still be registered
    expect(registeredAgents.has(SESSION_ID)).toBe(true);
    expect(registeredAgents.has("ephemeral-sub")).toBe(false);
    expect(mapServer.agents.has(SESSION_ID)).toBe(true);
  });

  it("main agent appears in TestServer event history as agent_registered", async () => {
    await sendSocketCommand(socketPath, {
      action: "spawn",
      agent: {
        agentId: SESSION_ID,
        name: "test-team-main",
        role: "orchestrator",
        scopes: [SCOPE],
        metadata: { isMain: true, sessionId: SESSION_ID },
      },
    });

    const registeredEvents = mapServer.eventHistory.filter(
      (e) => e.event.type === "agent_registered"
    );

    // At least sidecar + main agent
    expect(registeredEvents.length).toBeGreaterThanOrEqual(2);

    const mainEvent = registeredEvents.find(
      (e) => e.event.data?.name === "test-team-main" ||
             e.event.data?.agentId === SESSION_ID
    );
    expect(mainEvent).toBeDefined();
  });
});
