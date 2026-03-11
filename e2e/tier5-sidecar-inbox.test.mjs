/**
 * Tier 5: Sidecar + Inbox Integration Tests
 *
 * Real sidecar process, real UNIX sockets, mock MAP server.
 * No LLM calls — exercises the full sidecar/hook/inbox pipeline directly.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { MockMapServer } from "./helpers/map-mock-server.mjs";
import { startTestSidecar, sendCommand, isProcessAlive } from "./helpers/sidecar.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { waitFor } from "./helpers/cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");
const HOOK_SCRIPT = path.join(PLUGIN_DIR, "scripts", "map-hook.mjs");

// Use /tmp/ for short socket paths (macOS limits Unix socket paths to 104 bytes)
const SHORT_TMPDIR = "/tmp";

// Check if agent-inbox is available
let agentInboxAvailable = false;
try {
  await import("agent-inbox");
  agentInboxAvailable = true;
} catch {
  // Not installed
}

/**
 * Run a hook script with stdin data and return stdout + stderr.
 */
function runHook(action, stdinData, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK_SCRIPT, action], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.stdin.write(JSON.stringify(stdinData));
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr });
    }, 15000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Lifecycle Socket Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("tier5: sidecar lifecycle", { timeout: 60_000 }, () => {
  let mockServer;
  let workspace;
  let sidecar;

  beforeAll(async () => {
    mockServer = new MockMapServer();
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  afterEach(async () => {
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
    mockServer.clearMessages();
    if (workspace) {
      workspace.cleanup();
      workspace = null;
    }
  });

  it("starts and responds to ping", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    const resp = await sendCommand(sidecar.socketPath, { action: "ping" });
    expect(resp.ok).toBe(true);
    expect(resp.pid).toBeGreaterThan(0);
  });

  it("mock server receives connection from sidecar", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    expect(mockServer.connections.length).toBeGreaterThan(0);
    // Should have seen map/connect and map/agents/register
    const connectMsgs = mockServer.getByMethod("map/connect");
    const registerMsgs = mockServer.getByMethod("map/agents/register");
    expect(connectMsgs.length).toBeGreaterThan(0);
    expect(registerMsgs.length).toBeGreaterThan(0);
  });

  it("spawn -> done round-trip", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // Spawn
    const spawnResp = await sendCommand(sidecar.socketPath, {
      action: "spawn",
      agent: {
        agentId: "tu_123/coordinator",
        name: "coordinator",
        role: "coordinator",
        scopes: ["swarm:test"],
        metadata: { template: "gsd" },
      },
    });
    expect(spawnResp.ok).toBe(true);
    expect(spawnResp.agent).toBeDefined();

    // Verify mock received spawn
    expect(mockServer.spawnedAgents.length).toBe(1);
    expect(mockServer.spawnedAgents[0].agentId).toBe("tu_123/coordinator");

    // Done
    const doneResp = await sendCommand(sidecar.socketPath, {
      action: "done",
      agentId: "tu_123/coordinator",
      reason: "completed",
    });
    expect(doneResp.ok).toBe(true);

    // Verify mock received unregister for our specific agent
    const unregisters = mockServer.callExtensions.filter(
      (e) => e.method === "map/agents/unregister" && e.params?.agentId === "tu_123/coordinator"
    );
    expect(unregisters.length).toBe(1);
  });

  it("state update reaches mock server", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    const resp = await sendCommand(sidecar.socketPath, {
      action: "state",
      state: "busy",
      metadata: { lastStopReason: "tool_use" },
    });
    expect(resp.ok).toBe(true);

    // Verify mock received state update
    await waitFor(() => mockServer.stateUpdates.length > 0, 3000);
    expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
  });

  it("trajectory checkpoint with fallback", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // trajectory not supported → falls back to broadcast
    mockServer.trajectorySupported = false;
    const resp = await sendCommand(sidecar.socketPath, {
      action: "trajectory-checkpoint",
      checkpoint: {
        id: "cp1",
        agentId: "test-agent",
        sessionId: "test-session",
        label: "test checkpoint",
        metadata: { phase: "active" },
      },
    });
    expect(resp.ok).toBe(true);
    expect(resp.method).toBe("broadcast-fallback");

    // Verify fallback sent via map/send with trajectory.checkpoint payload
    const trajectoryMessages = mockServer.sentMessages.filter(
      (m) => m.payload?.type === "trajectory.checkpoint"
    );
    expect(trajectoryMessages.length).toBe(1);

    // Now test with trajectory supported
    mockServer.trajectorySupported = true;
    mockServer.clearMessages();
    const resp2 = await sendCommand(sidecar.socketPath, {
      action: "trajectory-checkpoint",
      checkpoint: { id: "cp2", agentId: "a", sessionId: "s", label: "l", metadata: {} },
    });
    expect(resp2.ok).toBe(true);
    expect(resp2.method).toBe("trajectory");
  });

  it("emit payload reaches mock server", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    const resp = await sendCommand(sidecar.socketPath, {
      action: "emit",
      event: { type: "task.dispatched", taskId: "t1", targetAgent: "tu_abc/researcher" },
    });
    expect(resp.ok).toBe(true);

    await waitFor(() => mockServer.sentMessages.length > 0, 3000);
    expect(mockServer.sentMessages.length).toBe(1);
    expect(mockServer.sentMessages[0].payload?.type).toBe("task.dispatched");
  });

  it("multiple agents lifecycle", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: { template: "gsd", map: { enabled: true, server: `ws://localhost:${mockServer.port}` } },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // Spawn 3 agents
    const agents = [
      { agentId: "tu_1/coordinator", name: "coordinator", role: "coordinator" },
      { agentId: "tu_2/researcher", name: "researcher", role: "researcher" },
      { agentId: "tu_3/executor", name: "executor", role: "executor" },
    ];

    for (const agent of agents) {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "spawn",
        agent: { ...agent, scopes: ["swarm:test"], metadata: {} },
      });
      expect(resp.ok).toBe(true);
    }
    expect(mockServer.spawnedAgents.length).toBe(3);

    // State updates
    for (const agent of agents) {
      await sendCommand(sidecar.socketPath, {
        action: "state",
        state: "busy",
        agentId: agent.agentId,
      });
    }

    // Done in sequence
    for (const agent of agents) {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "done",
        agentId: agent.agentId,
        reason: "completed",
      });
      expect(resp.ok).toBe(true);
    }

    const agentIds = agents.map((a) => a.agentId);
    const unregisters = mockServer.callExtensions.filter(
      (e) => e.method === "map/agents/unregister" && agentIds.includes(e.params?.agentId)
    );
    expect(unregisters.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Inbox Socket Tests (requires agent-inbox)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!agentInboxAvailable)(
  "tier5: inbox integration",
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
      await mockServer.stop();
    });

    afterEach(async () => {
      if (sidecar) {
        sidecar.cleanup();
        sidecar = null;
      }
      mockServer.clearMessages();
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
    });

    it("starts with both sockets when inbox configured", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      expect(fs.existsSync(sidecar.socketPath)).toBe(true);
      expect(sidecar.inboxReady).toBe(true);
      expect(fs.existsSync(sidecar.inboxSocketPath)).toBe(true);
    });

    it("starts with only lifecycle socket when inbox not configured", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        // No inboxConfig
      });

      expect(fs.existsSync(sidecar.socketPath)).toBe(true);
      expect(fs.existsSync(sidecar.inboxSocketPath)).toBe(false);
    });

    it("check_inbox returns empty initially", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      const resp = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        scope: "swarm:test",
      });
      expect(resp).not.toBeNull();
      expect(resp.ok).toBe(true);
      expect(resp.messages).toEqual([]);
    });

    it("message sent via IPC appears in check_inbox", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      // Send a message via agent-inbox IPC (the `send` action properly sets recipients)
      const sendResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "send",
        from: "ext-agent-1",
        to: "swarm:test",
        scope: "swarm:test",
        payload: { type: "text", text: "Hello from external agent" },
      });
      expect(sendResp?.ok).toBe(true);

      // Now check_inbox should find the message
      let resp;
      const found = await waitFor(async () => {
        resp = await sendCommand(sidecar.inboxSocketPath, {
          action: "check_inbox",
          scope: "swarm:test",
        });
        return resp?.ok && resp?.messages?.length > 0;
      }, 5000);

      expect(found).toBe(true);
      expect(resp.messages.length).toBeGreaterThan(0);

      // Verify sidecar is still alive
      expect(isProcessAlive(sidecar.pid)).toBe(true);
    });

    it("inbound MAP message appears in check_inbox via notification path", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      // Send a MAP message via mock server → SDK onMessage → agent-inbox handleIncoming
      mockServer.sendToAll(
        { type: "text", text: "Hello via MAP notification" },
        { from: "remote-agent-1", to: { scope: "swarm:test" } }
      );

      // Poll check_inbox — agent-inbox 0.1.3's resolveRecipients should set
      // recipients from the `to` field so the message is findable
      let resp;
      const found = await waitFor(async () => {
        resp = await sendCommand(sidecar.inboxSocketPath, {
          action: "check_inbox",
          scope: "swarm:test",
        });
        return resp?.ok && resp?.messages?.length > 0;
      }, 8000);

      expect(found).toBe(true);
      expect(resp.messages.length).toBe(1);
      const msg = resp.messages[0];
      expect(msg.sender_id).toBe("remote-agent-1");
      // Content should contain the original payload
      const text = msg.content?.text || (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      expect(text).toContain("Hello via MAP notification");
    });

    it("multiple MAP messages from different senders appear in check_inbox", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      // Send 3 messages from different external agents
      mockServer.sendToAll(
        { type: "text", text: "msg-1" },
        { from: "agent-alpha", to: { scope: "swarm:test" } }
      );
      mockServer.sendToAll(
        { type: "text", text: "msg-2" },
        { from: "agent-beta", to: { scope: "swarm:test" } }
      );
      mockServer.sendToAll(
        { type: "text", text: "msg-3" },
        { from: "agent-gamma", to: { scope: "swarm:test" } }
      );

      // Wait for all 3 messages to arrive
      let resp;
      const found = await waitFor(async () => {
        resp = await sendCommand(sidecar.inboxSocketPath, {
          action: "check_inbox",
          scope: "swarm:test",
        });
        return resp?.ok && resp?.messages?.length >= 3;
      }, 8000);

      expect(found).toBe(true);
      expect(resp.messages.length).toBe(3);
      const senders = resp.messages.map((m) => m.sender_id).sort();
      expect(senders).toEqual(["agent-alpha", "agent-beta", "agent-gamma"]);
    });

    it("MAP message addressed by agentId appears in check_inbox", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
          inbox: { enabled: true },
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      // Send with to: { agentId: "my-agent" } addressing
      mockServer.sendToAll(
        { type: "text", text: "direct message" },
        { from: "sender-1", to: { agentId: "my-agent" } }
      );

      let resp;
      const found = await waitFor(async () => {
        resp = await sendCommand(sidecar.inboxSocketPath, {
          action: "check_inbox",
          scope: "my-agent",
        });
        return resp?.ok && resp?.messages?.length > 0;
      }, 8000);

      expect(found).toBe(true);
      expect(resp.messages[0].sender_id).toBe("sender-1");
    });

    it("inject hook surfaces MAP-delivered messages as markdown", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}`, sidecar: "session" },
          inbox: { enabled: true },
        },
      });

      const mapDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "map");
      fs.mkdirSync(mapDir, { recursive: true });

      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      // Send via MAP notification path (not IPC)
      mockServer.sendToAll(
        { type: "text", text: "Urgent coordination update" },
        { from: "map-coordinator", to: { scope: "default" } }
      );

      // Wait for agent-inbox to store it
      await waitFor(async () => {
        const resp = await sendCommand(sidecar.inboxSocketPath, {
          action: "check_inbox",
          scope: "default",
        });
        return resp?.ok && resp?.messages?.length > 0;
      }, 8000);

      // Run inject hook — should read from agent-inbox IPC and output markdown
      const result = await runHook("inject", { session_id: "" }, workspace.dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("[MAP]");
      expect(result.stdout).toContain("map-coordinator");
    });

    it("implicit inbox enablement via MAP config only", async () => {
      // Config has only map.server — inbox should be implicitly enabled
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s5-",
        config: {
          template: "gsd",
          map: { server: `ws://localhost:${mockServer.port}` },
          // No explicit inbox config
        },
      });
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true }, // Sidecar still needs the flag
      });

      expect(fs.existsSync(sidecar.socketPath)).toBe(true);
      expect(sidecar.inboxReady).toBe(true);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Resilience Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("tier5: resilience", { timeout: 90_000 }, () => {
  let mockServer;
  let workspace;
  let sidecar;

  beforeAll(async () => {
    mockServer = new MockMapServer();
    await mockServer.start();
  });

  afterAll(async () => {
    mockServer.setResponseDelay(0);
    await mockServer.stop();
  });

  afterEach(async () => {
    mockServer.setResponseDelay(0);
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
    mockServer.clearMessages();
    if (workspace) {
      workspace.cleanup();
      workspace = null;
    }
  });

  it("sidecar starts with null connection when MAP server unavailable", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: "ws://localhost:1" }, // Nothing listening
      },
    });

    // Sidecar should still start (catches connection error)
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: 1, // Unreachable
    });

    // Lifecycle socket should work
    const resp = await sendCommand(sidecar.socketPath, { action: "ping" });
    expect(resp.ok).toBe(true);

    // Spawn should fail gracefully (no connection)
    const spawnResp = await sendCommand(sidecar.socketPath, {
      action: "spawn",
      agent: { agentId: "a", name: "a", role: "r", scopes: [], metadata: {} },
    });
    expect(spawnResp.ok).toBe(false);
    expect(spawnResp.error).toContain("no connection");
  });

  it("handles delayed MAP server responses", async () => {
    mockServer.setResponseDelay(2000); // 2s delay

    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
      },
    });

    // Sidecar should still connect (SDK has timeout > 2s)
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // Commands should work, just slower
    const start = Date.now();
    const resp = await sendCommand(sidecar.socketPath, {
      action: "spawn",
      agent: { agentId: "slow-1", name: "slow", role: "worker", scopes: ["s"], metadata: {} },
    });
    const elapsed = Date.now() - start;

    expect(resp.ok).toBe(true);
    expect(elapsed).toBeGreaterThan(1500); // Should have been delayed
  });

  it("inactivity timeout self-terminates sidecar", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
      },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
      inactivityTimeoutMs: 3000, // 3 seconds
    });

    const pid = sidecar.pid;
    expect(isProcessAlive(pid)).toBe(true);

    // Wait for timeout + buffer
    const died = await waitFor(() => !isProcessAlive(pid), 10000);
    expect(died).toBe(true);
  });

  it("inactivity timer resets on activity", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
      },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
      inactivityTimeoutMs: 4000,
    });

    const pid = sidecar.pid;

    // Send pings at 2s intervals to keep it alive past the 4s timeout
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      expect(isProcessAlive(pid)).toBe(true);
      await sendCommand(sidecar.socketPath, { action: "ping" });
    }

    // Should still be alive after 6s (3 × 2s pings)
    expect(isProcessAlive(pid)).toBe(true);

    // Now stop pinging — should die after ~4s
    const died = await waitFor(() => !isProcessAlive(pid), 8000);
    expect(died).toBe(true);
  });

  it("sidecar process is cleanly killable via SIGTERM", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
      },
    });
    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    const pid = sidecar.pid;
    expect(isProcessAlive(pid)).toBe(true);

    process.kill(pid, "SIGTERM");

    const died = await waitFor(() => !isProcessAlive(pid), 5000);
    expect(died).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Hook Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("tier5: hook integration", { timeout: 60_000 }, () => {
  let mockServer;
  let workspace;
  let sidecar;

  beforeAll(async () => {
    mockServer = new MockMapServer();
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  afterEach(async () => {
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
    mockServer.clearMessages();
    if (workspace) {
      workspace.cleanup();
      workspace = null;
    }
  });

  it("agent-spawning hook sends spawn + task.dispatched", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}`, sidecar: "session" },
      },
    });

    // Write roles.json so the hook can match roles
    const mapDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "map");
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapDir, "roles.json"),
      JSON.stringify({ team: "gsd", roles: ["coordinator", "researcher", "executor"], root: "coordinator", companions: [] })
    );

    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // Run the agent-spawning hook
    const hookData = {
      tool_input: { name: "coordinator", prompt: "Plan the project" },
      tool_use_id: "tu_hook_test",
      session_id: "",
    };

    const result = await runHook("agent-spawning", hookData, workspace.dir);
    expect(result.code).toBe(0);

    // Wait for mock to receive the spawn and message
    await waitFor(() => mockServer.spawnedAgents.length > 0, 5000);

    expect(mockServer.spawnedAgents.length).toBe(1);
    expect(mockServer.spawnedAgents[0].role).toBe("coordinator");

    // Should also have a task.dispatched message
    await waitFor(() => mockServer.sentMessages.length > 0, 3000);
    const dispatched = mockServer.sentMessages.find(
      (m) => m.payload?.type === "task.dispatched"
    );
    expect(dispatched).toBeDefined();
  });

  it("turn-completed hook updates state to idle", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}`, sidecar: "session" },
      },
    });

    // Ensure map dir exists
    const mapDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "map");
    fs.mkdirSync(mapDir, { recursive: true });

    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    const result = await runHook(
      "turn-completed",
      { stop_reason: "end_turn", session_id: "" },
      workspace.dir
    );
    expect(result.code).toBe(0);

    // Should see a state update
    await waitFor(() => mockServer.stateUpdates.length > 0, 5000);
    expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
  });

  it("inject hook reads inbox via agent-inbox IPC and outputs markdown", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}`, sidecar: "session" },
        inbox: { enabled: true },
      },
    });

    const mapDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "map");
    fs.mkdirSync(mapDir, { recursive: true });

    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
      inboxConfig: { enabled: true },
    });

    // Send a message via agent-inbox IPC (properly sets recipients for check_inbox)
    const scope = "default";
    await sendCommand(sidecar.inboxSocketPath, {
      action: "send",
      from: "agent-42",
      to: scope,
      scope,
      payload: { type: "text", text: "Hello from another agent" },
    });

    // Verify message is in inbox before running the hook
    await waitFor(async () => {
      const resp = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        scope,
      });
      return resp?.ok && resp?.messages?.length > 0;
    }, 5000);

    // Now run the inject hook — it should read from agent-inbox IPC
    const result = await runHook("inject", { session_id: "" }, workspace.dir);
    expect(result.code).toBe(0);

    // Should output markdown with the message
    expect(result.stdout).toContain("[MAP]");
    expect(result.stdout).toContain("agent-42");
  });

  it("agent-completed hook sends done + task.completed", async () => {
    workspace = createWorkspace({
      tmpdir: SHORT_TMPDIR, prefix: "s5-",
      config: {
        template: "gsd",
        map: { enabled: true, server: `ws://localhost:${mockServer.port}`, sidecar: "session" },
      },
    });

    const mapDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "map");
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapDir, "roles.json"),
      JSON.stringify({ team: "gsd", roles: ["coordinator", "researcher"], root: "coordinator", companions: [] })
    );

    sidecar = await startTestSidecar({
      workspaceDir: workspace.dir,
      mockServerPort: mockServer.port,
    });

    // First spawn the agent so it's registered
    await sendCommand(sidecar.socketPath, {
      action: "spawn",
      agent: {
        agentId: "tu_done_test/coordinator",
        name: "coordinator",
        role: "coordinator",
        scopes: ["swarm:test"],
        metadata: {},
      },
    });
    mockServer.clearMessages();

    const hookData = {
      tool_input: { name: "coordinator", prompt: "Plan the project" },
      tool_use_id: "tu_done_test",
      session_id: "",
    };

    const result = await runHook("agent-completed", hookData, workspace.dir);
    expect(result.code).toBe(0);

    // Should see unregister and task.completed
    await waitFor(
      () =>
        mockServer.callExtensions.some(
          (e) => e.method === "map/agents/unregister"
        ),
      5000
    );

    const unregisters = mockServer.callExtensions.filter(
      (e) => e.method === "map/agents/unregister"
    );
    expect(unregisters.length).toBe(1);

    await waitFor(() => mockServer.sentMessages.length > 0, 3000);
    const completed = mockServer.sentMessages.find(
      (m) => m.payload?.type === "task.completed"
    );
    expect(completed).toBeDefined();
  });
});
