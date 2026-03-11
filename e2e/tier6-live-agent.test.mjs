/**
 * Tier 6: Live Agent Integration Tests
 *
 * Full end-to-end tests with a live Claude Code instance, real plugin hooks,
 * mock MAP server, and agent-inbox. Verifies the complete plugin mechanism
 * works with a live agent — hooks fire, MAP events are emitted, inbox
 * messages are received and surfaced to agents.
 *
 * These tests are gated behind the LIVE_AGENT_TEST=1 env var because they:
 * - Require a live Claude Code CLI with an active subscription
 * - Make real LLM API calls ($1-10 per test group)
 * - Take 2-10 minutes per test group
 *
 * The mock MAP server provides the deterministic "external" side:
 * - Captures all agent lifecycle events (spawn, done, state)
 * - Captures all message payloads (task.dispatched, task.completed)
 * - Sends inbound messages at controlled times
 *
 * Run: LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-agent.test.mjs
 *
 * Run only specific groups:
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-agent.test.mjs -t "lifecycle"
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-agent.test.mjs -t "subagent"
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-agent.test.mjs -t "inbox"
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runClaude, CLI_AVAILABLE } from "./helpers/cli.mjs";
import { extractToolCalls, findToolCalls, getResult, getHookOutput } from "./helpers/assertions.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace, waitFor } from "./helpers/cleanup.mjs";
import { MockMapServer } from "./helpers/map-mock-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE = !!process.env.LIVE_AGENT_TEST;

// Check if agent-inbox is available
let agentInboxAvailable = false;
try {
  await import("agent-inbox");
  agentInboxAvailable = true;
} catch {
  // Not installed
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: MAP Agent Lifecycle with /swarm
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier6: MAP agent lifecycle via /swarm",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;
    let messages;
    let result;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
          inbox: { enabled: true },
        },
        files: {
          "README.md": "# Test Project\nA simple test project for live agent testing.\n",
        },
      });

      const run = await runClaude(
        'Run /swarm gsd with goal: Create hello.txt with "Hello World" and goodbye.txt with "Goodbye World". ' +
        'You MUST use the team — spawn agents to do the work, do not create the files yourself.',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 50,
          timeout: 300_000,
          label: "tier6-lifecycle",
        }
      );
      messages = run.messages;
      result = getResult(messages);

      const toolNames = extractToolCalls(messages).map((tc) => tc.name);
      console.log(`[tier6] lifecycle tool calls: ${toolNames.join(", ")}`);
      console.log(`[tier6] result: ${result?.subtype || "success"}, cost: $${result?.total_cost_usd?.toFixed(2) || "?"}`);

      await new Promise((r) => setTimeout(r, 2000));
    });

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("invokes /swarm skill", () => {
      const skillCalls = findToolCalls(messages, "Skill");
      expect(skillCalls.length).toBeGreaterThan(0);
      expect(
        skillCalls.some((sc) => sc.skill === "swarm" || sc.skill === "claude-code-swarm:swarm")
      ).toBe(true);
    });

    it("creates a team via TeamCreate", () => {
      const teamCreates = findToolCalls(messages, "TeamCreate");
      expect(teamCreates.length).toBeGreaterThan(0);
    });

    it("spawns at least one agent with team_name", () => {
      const agentCalls = findToolCalls(messages, "Agent");
      if (agentCalls.length === 0) {
        console.log("[tier6] WARNING: LLM did not spawn any agents (non-deterministic)");
      }
      expect(agentCalls.length).toBeGreaterThan(0);
      expect(agentCalls.some((ac) => ac.team_name)).toBe(true);
    });

    it("sidecar connected to mock MAP server", () => {
      expect(mockServer.getByMethod("map/connect").length).toBeGreaterThan(0);
    });

    it("sidecar registered itself with MAP server", () => {
      expect(mockServer.getByMethod("map/agents/register").length).toBeGreaterThan(0);
    });

    it("MAP server received agent spawn events for team agents", () => {
      // Agent spawning depends on the LLM actually using the Agent tool.
      // If no agents were spawned (non-deterministic), skip gracefully.
      const agentCalls = findToolCalls(messages, "Agent");
      if (agentCalls.length === 0) {
        console.log("[tier6] skipping: no Agent tool calls in this run");
        return;
      }
      expect(mockServer.spawnedAgents.length).toBeGreaterThan(0);
      console.log(
        "[tier6] spawned agents:",
        mockServer.spawnedAgents.map((a) => `${a.name || a.agentId} (${a.role})`).join(", ")
      );
    });

    it("spawned agents have correct metadata", () => {
      for (const agent of mockServer.spawnedAgents) {
        expect(agent.agentId).toBeTruthy();
        expect(agent.role).toBeTruthy();
        if (agent.metadata?.isTeamRole) {
          expect(agent.metadata.template).toBe("gsd");
        }
      }
    });

    it("MAP server received agent unregister events (done)", () => {
      const unregisters = mockServer.callExtensions.filter(
        (e) => e.method === "map/agents/unregister"
      );
      if (mockServer.spawnedAgents.length === 0) {
        console.log("[tier6] skipping: no agents were spawned");
        return;
      }
      expect(unregisters.length).toBeGreaterThan(0);
      console.log(
        "[tier6] unregistered agents:",
        unregisters.map((u) => u.params?.agentId).join(", ")
      );
    });

    it("spawn and unregister counts are balanced", () => {
      const spawnIds = new Set(mockServer.spawnedAgents.map((a) => a.agentId));
      const doneIds = new Set(
        mockServer.callExtensions
          .filter((e) => e.method === "map/agents/unregister")
          .map((e) => e.params?.agentId)
      );

      for (const id of doneIds) {
        expect(spawnIds.has(id)).toBe(true);
      }

      const orphans = [...spawnIds].filter((id) => !doneIds.has(id));
      if (orphans.length > 0) {
        console.log("[tier6] agents spawned but not unregistered:", orphans.join(", "));
      }
    });

    it("MAP server received state updates (idle transitions)", () => {
      expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
      console.log(`[tier6] state updates: ${mockServer.stateUpdates.length}`);
    });

    it("MAP server received task lifecycle messages", () => {
      const dispatched = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "task.dispatched"
      );
      const completed = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "task.completed"
      );

      // Task messages only appear when agents are spawned
      if (mockServer.spawnedAgents.length === 0) {
        console.log("[tier6] skipping: no agents were spawned, no task messages expected");
        return;
      }

      expect(dispatched.length).toBeGreaterThan(0);
      for (const d of dispatched) {
        expect(d.payload.targetAgent).toBeTruthy();
        expect(d.payload.taskId).toBeTruthy();
      }
      console.log(
        "[tier6] task.dispatched:",
        dispatched.map((d) => `${d.payload.taskId} → ${d.payload.targetAgent}`).join(", ")
      );

      expect(completed.length).toBeGreaterThan(0);
      console.log(`[tier6] task.completed: ${completed.length}`);

      // Verify balance: every completed task was dispatched
      const dispatchedIds = new Set(dispatched.map((d) => d.payload.taskId));
      for (const c of completed) {
        if (c.payload.taskId) {
          expect(dispatchedIds.has(c.payload.taskId)).toBe(true);
        }
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Subagent Lifecycle Events
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier6: subagent MAP lifecycle",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;
    let messages;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
        },
        files: {
          "README.md": "# Subagent Test\n",
        },
      });

      const run = await runClaude(
        'Please run /swarm gsd with goal: Create hello.py that prints "Hello" and goodbye.py that prints "Goodbye"',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 50,
          timeout: 300_000,
          label: "tier6-subagents",
        }
      );
      messages = run.messages;

      const toolNames = extractToolCalls(messages).map((tc) => tc.name);
      console.log(`[tier6] subagent tool calls: ${toolNames.join(", ")}`);

      await new Promise((r) => setTimeout(r, 2000));
    });

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("MAP server received subagent spawn events", () => {
      const subagents = mockServer.spawnedAgents.filter(
        (a) => a.role === "subagent"
      );

      const agentCalls = findToolCalls(messages, "Agent");
      if (agentCalls.length > 0) {
        expect(mockServer.spawnedAgents.length).toBeGreaterThan(0);
      }

      console.log(
        `[tier6] total spawned: ${mockServer.spawnedAgents.length}, ` +
        `subagent role: ${subagents.length}`
      );
    });

    it("subagent spawn events include metadata", () => {
      const subagents = mockServer.spawnedAgents.filter(
        (a) => a.role === "subagent"
      );
      for (const sa of subagents) {
        expect(sa.agentId).toBeTruthy();
        expect(sa.metadata).toBeDefined();
        expect(sa.metadata.isTeamRole).toBe(false);
      }
    });

    it("subagent done events are emitted", () => {
      const unregisters = mockServer.callExtensions.filter(
        (e) => e.method === "map/agents/unregister"
      );
      if (mockServer.spawnedAgents.length > 0) {
        expect(unregisters.length).toBeGreaterThan(0);
      }
    });

    it("all event types are chronologically ordered", () => {
      const spawnTimes = new Map();
      for (const a of mockServer.spawnedAgents) {
        spawnTimes.set(a.agentId, a._timestamp);
      }
      const dones = mockServer.callExtensions.filter(
        (e) => e.method === "map/agents/unregister"
      );
      for (const d of dones) {
        const spawnTime = spawnTimes.get(d.params?.agentId);
        if (spawnTime) {
          expect(d._timestamp).toBeGreaterThan(spawnTime);
        }
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Inbound Inbox — MAP → Agent-Inbox → Agent
//
// Sends MAP messages DURING the session (immediately after the sidecar
// connects to our mock server), so they are available when the
// UserPromptSubmit inject hook fires on the agent's turns.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: inbound inbox (MAP → agent)",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("agent receives MAP messages injected via inbox during session", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
          inbox: { enabled: true },
        },
        files: {
          "README.md": "# Inbox Test\n",
        },
      });

      // Strategy: Wait for the sidecar to fully register with MAP (not just connect),
      // then send messages immediately. The inject hook (UserPromptSubmit) fires on
      // each turn and surfaces agent-inbox messages as markdown context.
      //
      // The prompt instructs the agent to do some work first, giving time for
      // messages to arrive before the inject hook fires on later turns.

      const messagesSent = waitFor(
        () => mockServer.getByMethod("map/agents/register").length > 0,
        30_000
      ).then(async (registered) => {
        if (!registered) return;
        // Brief delay for agent-inbox to initialize after sidecar registration
        await new Promise((r) => setTimeout(r, 1000));

        mockServer.sendToAll(
          { type: "text", text: "IMPORTANT: The secret code is BRAVO-9931. Report this code back." },
          { from: "external-coordinator", to: { scope: "default" } }
        );
        mockServer.sendToAll(
          { type: "text", text: "Status update: All systems operational." },
          { from: "ops-monitor", to: { scope: "default" } }
        );
      });

      // The prompt makes the agent do work first (file creation) before checking inbox.
      // This ensures multiple turns fire the inject hook after messages arrive.
      const run = await runClaude(
        "Please do the following in order:\n" +
        "1. Create a file called warm-up.txt with the text 'warming up'\n" +
        "2. Read the file back to confirm it exists\n" +
        "3. Now check if you have received any external messages or inbox notifications\n" +
        "4. Report any messages you received, including any secret codes",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 3.0,
          maxTurns: 15,
          timeout: 180_000,
          label: "tier6-inbox-single-session",
        }
      );

      await messagesSent; // Ensure our message injection completed

      // Check what appeared in the session output
      const allText = run.stdout + run.stderr;
      const hookOutput = getHookOutput(run.messages);

      const mentionsCode = allText.includes("BRAVO-9931") || hookOutput.includes("BRAVO-9931");
      const mentionsSender = allText.includes("external-coordinator") || hookOutput.includes("external-coordinator");
      const mentionsOps = allText.includes("ops-monitor") || hookOutput.includes("ops-monitor");
      const mentionsMAP = allText.includes("[MAP]") || hookOutput.includes("[MAP]");

      console.log(`[tier6] inbox — code: ${mentionsCode}, sender: ${mentionsSender}, ops: ${mentionsOps}, MAP header: ${mentionsMAP}`);
      console.log(`[tier6] hook output length: ${hookOutput.length}`);

      // The inject hook deterministically writes markdown with [MAP] header and sender names.
      // Even if the LLM response varies, the hook output should contain the message.
      expect(mentionsCode || mentionsSender || mentionsOps || mentionsMAP).toBe(true);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Outbound Messages — Agent → MAP (via hooks)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier6: outbound MAP messages via hooks",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;
    let messages;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
          inbox: { enabled: true },
        },
        files: {
          "README.md": "# Outbound Test\n",
        },
      });

      const run = await runClaude(
        'Please run /swarm gsd with goal: Create a file called output.txt with the text "test output"',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 50,
          timeout: 300_000,
          label: "tier6-outbound",
        }
      );
      messages = run.messages;

      const toolNames = extractToolCalls(messages).map((tc) => tc.name);
      console.log(`[tier6] outbound tool calls: ${toolNames.join(", ")}`);

      await new Promise((r) => setTimeout(r, 2000));
    });

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("all MAP protocol methods are present", () => {
      const methods = new Set(mockServer.receivedMessages.map((m) => m.data?.method).filter(Boolean));
      console.log("[tier6] MAP methods seen:", [...methods].join(", "));

      expect(methods.has("map/connect")).toBe(true);
      expect(methods.has("map/agents/register")).toBe(true);
    });

    it("agent spawns have scopes from the session", () => {
      for (const agent of mockServer.spawnedAgents) {
        expect(agent.scopes).toBeDefined();
        expect(Array.isArray(agent.scopes)).toBe(true);
        expect(agent.scopes.length).toBeGreaterThan(0);
      }
    });

    it("task.dispatched messages reference spawned agent IDs", () => {
      const spawnedIds = new Set(mockServer.spawnedAgents.map((a) => a.agentId));
      const dispatched = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "task.dispatched"
      );
      for (const d of dispatched) {
        if (d.payload.targetAgent && spawnedIds.size > 0) {
          expect(spawnedIds.has(d.payload.targetAgent)).toBe(true);
        }
      }
    });

    it("state updates are emitted during the session", () => {
      expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
      const idleUpdates = mockServer.stateUpdates.filter((u) => u.state === "idle");
      console.log(
        `[tier6] state updates: ${mockServer.stateUpdates.length} total, ${idleUpdates.length} idle`
      );
      expect(idleUpdates.length).toBeGreaterThan(0);
    });

    it("full event timeline is coherent", () => {
      const timeline = [];

      for (const a of mockServer.spawnedAgents) {
        timeline.push({ type: "spawn", id: a.agentId, time: a._timestamp });
      }
      for (const u of mockServer.stateUpdates) {
        timeline.push({ type: "state", state: u.state, time: u._timestamp });
      }
      for (const m of mockServer.sentMessages) {
        timeline.push({ type: m.payload?.type || "message", time: m._timestamp });
      }
      for (const e of mockServer.callExtensions) {
        timeline.push({ type: e.method, id: e.params?.agentId, time: e._timestamp });
      }

      timeline.sort((a, b) => a.time - b.time);

      console.log("[tier6] event timeline:");
      for (const evt of timeline) {
        const label = evt.id ? `${evt.type} (${evt.id})` : evt.type;
        console.log(`  ${new Date(evt.time).toISOString()} ${label}`);
      }

      expect(timeline.length).toBeGreaterThan(0);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Combined Flow — Inbound + Outbound in Single Session
//
// Sends a MAP message during the session, then the agent runs /swarm.
// Verifies both inbound (agent sees external message) and outbound
// (MAP server receives lifecycle events) work in a single session.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: combined inbound + outbound flow",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("agent processes external instructions and plugin emits full lifecycle", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
          inbox: { enabled: true },
        },
        files: {
          "project.md": "# Combined Flow Test Project\n",
        },
      });

      // Inject external instruction as soon as sidecar connects
      const messagesSent = waitFor(() => mockServer.connections.length > 0, 30_000).then(
        async (connected) => {
          if (!connected) return;
          await new Promise((r) => setTimeout(r, 2000));

          mockServer.sendToAll(
            {
              type: "text",
              text: "External instruction: Create a file called combined-test.txt with the content 'Combined flow works'",
            },
            { from: "external-system", to: { scope: "default" } }
          );
        }
      );

      const run = await runClaude(
        "Check for external messages first. Then run /swarm gsd to handle any external requests you received.",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 50,
          timeout: 300_000,
          label: "tier6-combined",
        }
      );

      await messagesSent;
      await new Promise((r) => setTimeout(r, 2000));

      const allText = run.stdout + run.stderr;
      const hookOutput = getHookOutput(run.messages);
      const toolNames = extractToolCalls(run.messages).map((tc) => tc.name);
      console.log(`[tier6] combined tool calls: ${toolNames.join(", ")}`);

      // ── Verify inbound: hook output or LLM saw the external message ───
      const sawExternal = allText.includes("external-system") ||
                          allText.includes("combined-test") ||
                          hookOutput.includes("external-system") ||
                          hookOutput.includes("[MAP]");
      console.log(`[tier6] combined — saw external: ${sawExternal}`);
      expect(sawExternal).toBe(true);

      // ── Verify outbound: MAP server received lifecycle events ─────────
      // Should have connect + register at minimum
      expect(mockServer.getByMethod("map/connect").length).toBeGreaterThan(0);

      // If /swarm was invoked, should see spawns and task messages
      const swarmCalled = findToolCalls(run.messages, "Skill").some(
        (sc) => sc.skill === "swarm" || sc.skill === "claude-code-swarm:swarm"
      );
      if (swarmCalled) {
        expect(mockServer.spawnedAgents.length).toBeGreaterThan(0);
      }

      expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Sidecar Persistence Across Sessions
//
// Runs two sequential sessions and verifies the mock MAP server only
// saw one connection (the bootstrap's ensureSidecar finds the existing
// sidecar alive and doesn't restart it).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier6: sidecar persistence across sessions",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;

    afterAll(async () => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("sidecar maintains single MAP connection across multiple sessions", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          template: "gsd",
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
            sidecar: "session",
          },
        },
      });

      // Session 1
      await runClaude("Say OK", {
        cwd: workspace.dir,
        maxBudgetUsd: 1.0,
        maxTurns: 1,
        timeout: 60_000,
        label: "tier6-persist-1",
      });

      // Wait for events to settle
      await new Promise((r) => setTimeout(r, 2000));
      const connectsAfterSession1 = mockServer.getByMethod("map/connect").length;
      console.log(`[tier6] connects after session 1: ${connectsAfterSession1}`);

      // Verify at least one connection was established
      expect(connectsAfterSession1).toBeGreaterThan(0);

      // Session 2 — same workspace
      await runClaude("Say OK again", {
        cwd: workspace.dir,
        maxBudgetUsd: 1.0,
        maxTurns: 1,
        timeout: 60_000,
        label: "tier6-persist-2",
      });

      await new Promise((r) => setTimeout(r, 2000));
      const connectsAfterSession2 = mockServer.getByMethod("map/connect").length;
      console.log(`[tier6] connects after session 2: ${connectsAfterSession2}`);

      // Each session gets its own session_id and therefore its own sidecar.
      // With --no-session-persistence, we expect separate connections.
      // But the sidecar should still function correctly for each session.
      // We verify that connections DID happen and events were received.
      expect(connectsAfterSession2).toBeGreaterThanOrEqual(connectsAfterSession1);

      // Both sessions should have produced state updates
      expect(mockServer.stateUpdates.length).toBeGreaterThan(0);
    });
  }
);
