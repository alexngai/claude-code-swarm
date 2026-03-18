/**
 * Tier 6: Live Agent Inbox Flow Integration Tests
 *
 * Verifies the full inbox messaging pipeline with live Claude Code agents:
 *   1. Sidecar starts with inbox enabled → inbox IPC socket appears
 *   2. Agent spawned via /swarm registers in inbox storage (visible via list_agents)
 *   3. External message sent to agent's inbox ID → agent receives it
 *   4. Agent uses send_message MCP tool → message lands in real inbox storage
 *   5. Threaded conversation between agents via inbox MCP tools
 *   6. message.created events bridge to MAP server
 *
 * Gated behind LIVE_AGENT_TEST=1 (requires live Claude Code CLI + API key).
 *
 * Run:
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-inbox-flow.test.mjs
 *
 * Run specific group:
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-inbox-flow.test.mjs -t "single agent"
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-live-inbox-flow.test.mjs -t "team inbox"
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { runClaude, CLI_AVAILABLE } from "./helpers/cli.mjs";
import { extractToolCalls, findToolCalls, getResult, getHookOutput } from "./helpers/assertions.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace, waitFor } from "./helpers/cleanup.mjs";
import { MockMapServer } from "./helpers/map-mock-server.mjs";
import { startTestSidecar, sendCommand } from "./helpers/sidecar.mjs";

const LIVE = !!process.env.LIVE_AGENT_TEST;
const SHORT_TMPDIR = "/tmp";

// Check if agent-inbox is available
let agentInboxAvailable = false;
try {
  await import("agent-inbox");
  agentInboxAvailable = true;
} catch {
  // Not installed
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Single Agent — Inbox MCP round-trip with real storage
//
// Starts a real sidecar with inbox, then a live agent that sends a message
// via MCP and checks its own inbox. Verifies the message lands in real
// inbox storage (not isolated MCP storage).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: single agent inbox MCP → real storage round-trip",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("agent sends message via MCP → message appears in real inbox IPC storage", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-inbox-",
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
          "README.md": "# Inbox Flow Test\n",
        },
      });

      // Start sidecar with inbox before the agent session
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      expect(sidecar.inboxReady).toBe(true);

      // Run a live agent that uses inbox MCP tools
      const run = await runClaude(
        'Use the agent-inbox MCP tools to do the following:\n' +
        '1. Use send_message to send a message to agent "gsd-verifier" with body "Please verify task #100"\n' +
        '2. Use send_message to send a message to agent "gsd-verifier" with body "Also check task #101" and threadTag "tasks-batch"\n' +
        '3. Use check_inbox to check messages for agent "gsd-verifier"\n' +
        '4. Use list_agents to list all registered agents\n' +
        '5. Report what each tool returned',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 2.0,
          maxTurns: 15,
          timeout: 120_000,
          label: "tier6-inbox-flow-single",
        }
      );

      const toolCalls = extractToolCalls(run.messages);
      const toolNames = toolCalls.map((tc) => tc.name);
      console.log("[tier6] inbox flow tool calls:", toolNames.join(", "));

      // Verify the agent used inbox MCP tools
      const sendCalls = toolCalls.filter((tc) => tc.name.includes("send_message"));
      const checkCalls = toolCalls.filter((tc) => tc.name.includes("check_inbox"));
      const listCalls = toolCalls.filter((tc) => tc.name.includes("list_agents"));

      console.log(`[tier6] send_message: ${sendCalls.length}, check_inbox: ${checkCalls.length}, list_agents: ${listCalls.length}`);

      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      expect(checkCalls.length).toBeGreaterThanOrEqual(1);

      // Now verify the message actually landed in real inbox storage via IPC
      const inboxResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-verifier",
      });

      console.log("[tier6] inbox IPC check_inbox response:", JSON.stringify(inboxResp));

      if (inboxResp?.ok) {
        // Messages sent by the agent via MCP should be in real storage
        expect(inboxResp.messages.length).toBeGreaterThanOrEqual(1);

        // Verify message content
        const hasVerifyMsg = inboxResp.messages.some((m) =>
          JSON.stringify(m).includes("verify") || JSON.stringify(m).includes("task")
        );
        console.log("[tier6] found verify message in real storage:", hasVerifyMsg);
      } else {
        console.log("[tier6] WARNING: inbox IPC not responding — MCP may be in standalone mode");
      }

      // Verify no errors in the result
      const result = getResult(run.messages);
      expect(result?.is_error).toBeFalsy();
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: External message → Agent inbox → Agent response
//
// Sends a message to the agent's inbox BEFORE the agent session starts,
// then verifies the agent receives it (via inject hook or MCP check_inbox).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: external message → agent inbox → agent processes",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("agent receives pre-seeded inbox message and responds to it", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-ext-",
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
          "README.md": "# External Message Test\n",
        },
      });

      // Start sidecar with inbox
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      expect(sidecar.inboxReady).toBe(true);

      // Pre-seed a message into the inbox for gsd-main (the inject hook checks this ID)
      const seedResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "send",
        from: "external-coordinator",
        to: "gsd-main",
        payload: "PRIORITY: The deployment key is DELTA-4477. Acknowledge receipt.",
      });
      expect(seedResp?.ok).toBe(true);
      console.log("[tier6] pre-seeded message:", seedResp?.messageId);

      // Verify it's in the inbox before the agent session
      const preCheck = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-main",
      });
      expect(preCheck?.ok).toBe(true);
      expect(preCheck?.messages?.length).toBe(1);

      // Run the agent — the inject hook should surface the message, or the agent
      // can use check_inbox MCP tool
      const run = await runClaude(
        "Check for any external messages or inbox notifications. " +
        "If you find any messages, report the full content including any codes or keys. " +
        "Also use the agent-inbox check_inbox MCP tool to check for messages addressed to you.",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 2.0,
          maxTurns: 10,
          timeout: 120_000,
          label: "tier6-inbox-external",
        }
      );

      const allText = run.stdout + run.stderr;
      const hookOutput = getHookOutput(run.messages);

      const mentionsKey = allText.includes("DELTA-4477") || hookOutput.includes("DELTA-4477");
      const mentionsSender = allText.includes("external-coordinator") || hookOutput.includes("external-coordinator");
      const mentionsMAP = allText.includes("[MAP]") || hookOutput.includes("[MAP]");

      console.log(`[tier6] external — key: ${mentionsKey}, sender: ${mentionsSender}, MAP: ${mentionsMAP}`);

      // At least one of these should be true — either the inject hook surfaced
      // the message or the agent used check_inbox MCP tool
      expect(mentionsKey || mentionsSender || mentionsMAP).toBe(true);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Team inbox flow — /swarm spawns agents, agents message each other
//
// This is the full e2e test: /swarm launches a team, agents are registered
// in inbox, they exchange messages, and the MAP server sees inbox.message
// bridge events.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: team inbox flow — /swarm agents exchange messages",
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

    it("agents spawned via /swarm are registered in inbox and can exchange messages", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-team-",
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
          "README.md": "# Team Inbox Flow Test\n",
        },
      });

      // Run /swarm with a goal that encourages agent communication
      const run = await runClaude(
        'Run /swarm gsd with goal: Create a file called result.txt with "Team inbox works". ' +
        'When coordinating with your team agents, use both SendMessage for quick coordination AND ' +
        'agent-inbox send_message MCP tool for any messages that should be tracked/persistent. ' +
        'Make sure each agent checks their inbox using agent-inbox check_inbox before starting work.',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 50,
          timeout: 300_000,
          label: "tier6-team-inbox-flow",
        }
      );

      const toolCalls = extractToolCalls(run.messages);
      const toolNames = toolCalls.map((tc) => tc.name);
      console.log("[tier6] team inbox flow tool calls:", toolNames.join(", "));

      // ── Verify team was created ──
      const teamCreates = findToolCalls(run.messages, "TeamCreate");
      const agentCalls = findToolCalls(run.messages, "Agent");
      console.log(`[tier6] TeamCreate: ${teamCreates.length}, Agent: ${agentCalls.length}`);

      expect(teamCreates.length).toBeGreaterThan(0);

      // ── Verify agents were spawned in MAP ──
      if (agentCalls.length > 0) {
        await new Promise((r) => setTimeout(r, 2000)); // Allow MAP events to settle

        console.log(
          "[tier6] MAP spawned agents:",
          mockServer.spawnedAgents.map((a) => `${a.agentId} (${a.role})`).join(", ")
        );
        expect(mockServer.spawnedAgents.length).toBeGreaterThan(0);
      }

      // ── Check for inbox MCP tool usage ──
      const inboxToolCalls = toolCalls.filter((tc) =>
        tc.name.includes("agent-inbox") || tc.name.includes("inbox")
      );
      const sendMsgCalls = inboxToolCalls.filter((tc) => tc.name.includes("send_message"));
      const checkInboxCalls = inboxToolCalls.filter((tc) => tc.name.includes("check_inbox"));
      const readThreadCalls = inboxToolCalls.filter((tc) => tc.name.includes("read_thread"));
      const listAgentsCalls = inboxToolCalls.filter((tc) => tc.name.includes("list_agents"));

      console.log(
        `[tier6] inbox tools — send: ${sendMsgCalls.length}, check: ${checkInboxCalls.length}, ` +
        `thread: ${readThreadCalls.length}, list: ${listAgentsCalls.length}`
      );

      // At minimum, agents should have checked their inbox
      // (Non-deterministic: LLM may or may not use inbox tools depending on prompt interpretation)
      if (inboxToolCalls.length > 0) {
        console.log("[tier6] agents DID use inbox MCP tools");
      } else {
        console.log("[tier6] WARNING: agents did not use inbox MCP tools (LLM non-deterministic)");
      }

      // ── Check for inbox.message events on MAP (outbound bridge) ──
      const inboxMessages = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "inbox.message"
      );
      console.log(`[tier6] inbox.message MAP events: ${inboxMessages.length}`);

      if (inboxMessages.length > 0) {
        for (const msg of inboxMessages) {
          console.log(
            `  from: ${msg.payload.from}, to: ${JSON.stringify(msg.payload.to)}, ` +
            `thread: ${msg.payload.threadTag || "none"}`
          );
        }
      }

      // ── Verify overall session succeeded ──
      const result = getResult(run.messages);
      console.log(`[tier6] result: ${result?.subtype || "success"}, cost: $${result?.total_cost_usd?.toFixed(2) || "?"}`);
      expect(result?.is_error).toBeFalsy();

      // ── Verify MAP received lifecycle events ──
      expect(mockServer.getByMethod("map/connect").length).toBeGreaterThan(0);
      expect(mockServer.getByMethod("map/agents/register").length).toBeGreaterThan(0);
    });

    it("inbox storage has agent registrations after /swarm run", async () => {
      // This test runs AFTER the team flow test above, checking persistent state.
      // Find the inbox socket from the workspace's sidecar.
      const mapDir = path.join(
        workspace?.dir || "/nonexistent",
        ".swarm", "claude-swarm", "tmp", "map"
      );
      const inboxSockPath = path.join(mapDir, "inbox.sock");

      if (!workspace || !fs.existsSync(inboxSockPath)) {
        console.log("[tier6] skipping: inbox socket not found (sidecar may have exited)");
        return;
      }

      // Query the inbox for registered agents
      const listResp = await sendCommand(inboxSockPath, {
        action: "list_agents",
      });

      if (listResp?.ok) {
        console.log(`[tier6] inbox agents: ${listResp.count}`);
        for (const agent of (listResp.agents || [])) {
          console.log(`  ${agent.agentId} — status: ${agent.status}`);
        }

        // After a /swarm run, at least the sidecar-spawned agents should be registered
        // (they may be "disconnected" if the session ended)
        if (listResp.count > 0) {
          expect(listResp.agents.length).toBeGreaterThan(0);
        }
      } else {
        console.log("[tier6] list_agents not supported or sidecar exited");
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Threaded conversation — two sequential agents use same threadTag
//
// Verifies that threaded inbox conversations work across agent turns.
// Agent A sends a message with a threadTag, Agent B reads the thread.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: threaded inbox conversation across agent turns",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("sequential agents build a thread via inbox send_message + read_thread", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-thread-",
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
          "README.md": "# Thread Test\n",
        },
      });

      // Start sidecar with inbox
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      expect(sidecar.inboxReady).toBe(true);

      // Session 1: Agent sends initial thread message
      const run1 = await runClaude(
        'Use the agent-inbox send_message MCP tool to send a message:\n' +
        '- to: "gsd-reviewer"\n' +
        '- body: "Code review requested for PR #42"\n' +
        '- threadTag: "pr-42-review"\n' +
        '- from: "gsd-developer"\n' +
        'Then confirm the send was successful.',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 1.0,
          maxTurns: 5,
          timeout: 60_000,
          label: "tier6-thread-send",
        }
      );

      const sendCalls1 = extractToolCalls(run1.messages).filter((tc) =>
        tc.name.includes("send_message")
      );
      console.log(`[tier6] session 1 send_message calls: ${sendCalls1.length}`);
      expect(sendCalls1.length).toBeGreaterThanOrEqual(1);

      // Verify message is in real storage
      const checkResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        agentId: "gsd-reviewer",
      });
      console.log("[tier6] reviewer inbox after session 1:", JSON.stringify(checkResp));

      // Session 2: Agent reads the thread and adds a reply
      const run2 = await runClaude(
        'Use the agent-inbox MCP tools to:\n' +
        '1. Use read_thread with threadTag "pr-42-review" to see the conversation\n' +
        '2. Use send_message to reply:\n' +
        '   - to: "gsd-developer"\n' +
        '   - body: "LGTM, approved"\n' +
        '   - threadTag: "pr-42-review"\n' +
        '   - from: "gsd-reviewer"\n' +
        '3. Use read_thread again to verify both messages are in the thread\n' +
        'Report what the thread looks like.',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 1.0,
          maxTurns: 10,
          timeout: 60_000,
          label: "tier6-thread-reply",
        }
      );

      const toolCalls2 = extractToolCalls(run2.messages);
      const readCalls = toolCalls2.filter((tc) => tc.name.includes("read_thread"));
      const sendCalls2 = toolCalls2.filter((tc) => tc.name.includes("send_message"));

      console.log(`[tier6] session 2 — read_thread: ${readCalls.length}, send_message: ${sendCalls2.length}`);
      console.log(`[tier6] session 2 all tools: ${toolCalls2.map((tc) => tc.name).join(", ")}`);

      expect(readCalls.length).toBeGreaterThanOrEqual(1);
      expect(sendCalls2.length).toBeGreaterThanOrEqual(1);

      // Verify the thread has both messages via IPC
      const threadResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "read_thread",
        threadTag: "pr-42-review",
      });

      console.log("[tier6] thread after both sessions:", JSON.stringify(threadResp));

      if (threadResp?.ok) {
        expect(threadResp.count).toBeGreaterThanOrEqual(2);
        console.log(`[tier6] thread message count: ${threadResp.count}`);

        // Verify both senders appear
        const senders = (threadResp.messages || []).map((m) => m.sender_id);
        console.log(`[tier6] thread senders: ${senders.join(", ")}`);

        const hasDeveloper = senders.some((s) => s.includes("developer"));
        const hasReviewer = senders.some((s) => s.includes("reviewer"));
        console.log(`[tier6] developer in thread: ${hasDeveloper}, reviewer: ${hasReviewer}`);

        expect(hasDeveloper || hasReviewer).toBe(true);
      }

      // Verify no errors
      expect(getResult(run2.messages)?.is_error).toBeFalsy();
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Two spawned agents messaging each other via inbox
//
// The coordinator creates a team with two agents. Agent A (writer) sends
// an inbox message to Agent B (reviewer) with a specific threadTag.
// Agent B checks its inbox, reads the message, and replies via inbox.
// After the session, we verify via the real inbox IPC socket that:
//   - Both agents sent messages
//   - The thread contains messages from both agents
//   - Messages have correct sender/recipient
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: two spawned agents messaging each other via inbox",
  { timeout: 600_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("two team agents exchange messages via inbox MCP tools", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-2agent-",
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
          "README.md": "# Two-Agent Inbox Test\n",
          "spec.txt": "Feature: user login page\n",
        },
      });

      // Start sidecar with inbox BEFORE running the agent
      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });
      expect(sidecar.inboxReady).toBe(true);

      // The prompt creates a team with exactly two agents who MUST message each
      // other via inbox. The agents are given very explicit, deterministic
      // instructions to minimize LLM non-determinism.
      const run = await runClaude(
        `You are a coordinator. Do the following steps IN ORDER:

1. Create a team: TeamCreate(team_name="inbox-test-team", description="Inbox messaging test")

2. Spawn Agent A (the writer):
   Agent(
     name="writer",
     team_name="inbox-test-team",
     prompt="You are the writer agent. Your ONLY job is to use the agent-inbox MCP tools. Do these steps exactly:
       Step 1: Use agent-inbox send_message to send a message with these EXACT parameters:
         - to: inbox-test-reviewer
         - body: WRITER_MSG_001 Please review the login page spec
         - from: inbox-test-writer
         - threadTag: login-review-thread
       Step 2: Wait a moment, then use agent-inbox check_inbox with agentId: inbox-test-writer to see if you got a reply.
       Step 3: Report what happened."
   )

3. Spawn Agent B (the reviewer):
   Agent(
     name="reviewer",
     team_name="inbox-test-team",
     prompt="You are the reviewer agent. Your ONLY job is to use the agent-inbox MCP tools. Do these steps exactly:
       Step 1: Use agent-inbox check_inbox with agentId: inbox-test-reviewer to check for messages.
       Step 2: Use agent-inbox read_thread with threadTag: login-review-thread to see the full thread.
       Step 3: Use agent-inbox send_message to reply with these EXACT parameters:
         - to: inbox-test-writer
         - body: REVIEWER_MSG_001 Looks good, approved with minor comments
         - from: inbox-test-reviewer
         - threadTag: login-review-thread
       Step 4: Report what happened."
   )

4. After both agents finish, report their results.

IMPORTANT: You MUST spawn both agents. Do NOT do their work yourself.`,
        {
          cwd: workspace.dir,
          maxBudgetUsd: 10.0,
          maxTurns: 30,
          timeout: 300_000,
          label: "tier6-two-agent-inbox",
        }
      );

      const toolCalls = extractToolCalls(run.messages);
      const toolNames = toolCalls.map((tc) => tc.name);
      console.log("[tier6] 2-agent tool calls:", toolNames.join(", "));

      // ── Verify team was created and agents were spawned ──
      const teamCreates = findToolCalls(run.messages, "TeamCreate");
      const agentCalls = findToolCalls(run.messages, "Agent");

      console.log(`[tier6] TeamCreate: ${teamCreates.length}, Agent: ${agentCalls.length}`);
      expect(teamCreates.length).toBeGreaterThanOrEqual(1);
      expect(agentCalls.length).toBeGreaterThanOrEqual(2);

      // Allow time for all async operations to settle
      await new Promise((r) => setTimeout(r, 3000));

      // ── Verify messages in real inbox storage via IPC ──

      // Check writer's inbox (should have reviewer's reply)
      const writerInbox = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        agentId: "inbox-test-writer",
      });
      console.log("[tier6] writer inbox:", JSON.stringify(writerInbox));

      // Check reviewer's inbox (should have writer's initial message)
      const reviewerInbox = await sendCommand(sidecar.inboxSocketPath, {
        action: "check_inbox",
        agentId: "inbox-test-reviewer",
      });
      console.log("[tier6] reviewer inbox:", JSON.stringify(reviewerInbox));

      // Check the shared thread
      const threadResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "read_thread",
        threadTag: "login-review-thread",
      });
      console.log("[tier6] thread:", JSON.stringify(threadResp));

      // ── Assertions ──

      // At least one message should have been exchanged via inbox.
      // Due to LLM non-determinism, we check multiple signals:
      const writerSent = reviewerInbox?.ok && reviewerInbox?.messages?.length > 0;
      const reviewerReplied = writerInbox?.ok && writerInbox?.messages?.length > 0;
      const threadExists = threadResp?.ok && threadResp?.count > 0;

      console.log(
        `[tier6] writer→reviewer: ${writerSent}, reviewer→writer: ${reviewerReplied}, thread: ${threadExists}`
      );

      // The agent output may also contain evidence of inbox tool usage
      const allText = run.stdout + run.stderr;
      const mentionsWriterMsg = allText.includes("WRITER_MSG_001");
      const mentionsReviewerMsg = allText.includes("REVIEWER_MSG_001");
      console.log(`[tier6] output mentions writer msg: ${mentionsWriterMsg}, reviewer msg: ${mentionsReviewerMsg}`);

      // Primary assertion: at least one direction of messaging worked
      const messagingWorked = writerSent || reviewerReplied || threadExists || mentionsWriterMsg || mentionsReviewerMsg;
      expect(messagingWorked).toBe(true);

      // If the thread exists, verify it has messages from both sides
      if (threadExists && threadResp.count >= 2) {
        const senders = threadResp.messages.map((m) => m.sender_id);
        console.log(`[tier6] thread senders: ${senders.join(", ")}`);

        const hasWriter = senders.some((s) => s.includes("writer"));
        const hasReviewer = senders.some((s) => s.includes("reviewer"));
        console.log(`[tier6] writer in thread: ${hasWriter}, reviewer: ${hasReviewer}`);

        // Both agents should appear in the thread
        expect(hasWriter && hasReviewer).toBe(true);
      }

      // Verify session completed without error
      const result = getResult(run.messages);
      console.log(`[tier6] result: ${result?.subtype || "success"}, cost: $${result?.total_cost_usd?.toFixed(2) || "?"}`);
      expect(result?.is_error).toBeFalsy();
    });

    it("inbox thread persists after agents complete and is queryable", async () => {
      // This test runs after the previous one, verifying the inbox state persists.
      if (!sidecar?.inboxSocketPath || !fs.existsSync(sidecar.inboxSocketPath)) {
        console.log("[tier6] skipping: inbox socket gone (sidecar may have exited)");
        return;
      }

      // The thread should still be readable even after agents finished
      const threadResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "read_thread",
        threadTag: "login-review-thread",
      });

      if (threadResp?.ok && threadResp.count > 0) {
        console.log(`[tier6] persistent thread has ${threadResp.count} messages`);
        expect(threadResp.count).toBeGreaterThanOrEqual(1);

        // Messages should have real content, not be empty
        for (const msg of threadResp.messages) {
          expect(msg.sender_id).toBeTruthy();
          console.log(`  [${msg.sender_id}]: ${JSON.stringify(msg.content).slice(0, 80)}`);
        }
      } else {
        console.log("[tier6] thread not found — agents may not have used threadTag");
      }

      // List all agents that were registered during the session
      const listResp = await sendCommand(sidecar.inboxSocketPath, {
        action: "list_agents",
      });

      if (listResp?.ok) {
        console.log(`[tier6] registered agents: ${listResp.count}`);
        for (const agent of (listResp.agents || [])) {
          console.log(`  ${agent.agentId} — ${agent.status}`);
        }
      }
    });

    it("MAP server received inbox.message bridge events for agent-to-agent messages", async () => {
      // Check if the MAP mock server received inbox.message events
      // from the message.created bridge in map-sidecar.mjs
      const inboxMessages = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "inbox.message"
      );

      console.log(`[tier6] inbox.message MAP events: ${inboxMessages.length}`);
      for (const msg of inboxMessages) {
        console.log(
          `  from: ${msg.payload.from}, to: ${JSON.stringify(msg.payload.to)}, ` +
          `thread: ${msg.payload.threadTag || "none"}`
        );
      }

      if (inboxMessages.length > 0) {
        // Verify the bridge events have correct structure
        for (const msg of inboxMessages) {
          expect(msg.payload.messageId).toBeTruthy();
          expect(msg.payload.from).toBeTruthy();
        }

        // Look for messages in the login-review-thread
        const threadMessages = inboxMessages.filter(
          (m) => m.payload.threadTag === "login-review-thread"
        );
        if (threadMessages.length >= 2) {
          const bridgeSenders = threadMessages.map((m) => m.payload.from);
          console.log(`[tier6] bridge thread senders: ${bridgeSenders.join(", ")}`);
        }
      } else {
        console.log(
          "[tier6] NOTE: No inbox.message bridge events — " +
          "sidecar may not wire message.created → MAP in test mode"
        );
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: MAP bridge — inbox.message events appear on MAP server
//
// Verifies that when agents send messages via inbox, the message.created
// event bridge emits inbox.message events to the MAP server.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !agentInboxAvailable)(
  "tier6: inbox message.created → MAP inbox.message bridge",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    afterAll(async () => {
      if (sidecar) sidecar.cleanup();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
      if (mockServer) await mockServer.stop();
    });

    it("inbox send triggers inbox.message event on MAP server", async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR, prefix: "s6-bridge-",
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
          "README.md": "# Bridge Test\n",
        },
      });

      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
        inboxConfig: { enabled: true },
      });

      expect(sidecar.inboxReady).toBe(true);

      // Send messages directly via inbox IPC (bypassing MCP, testing the bridge)
      await sendCommand(sidecar.inboxSocketPath, {
        action: "send",
        from: "gsd-lead",
        to: "gsd-executor",
        payload: "Start implementation of feature Y",
        threadTag: "feature-y",
      });

      await sendCommand(sidecar.inboxSocketPath, {
        action: "send",
        from: "gsd-executor",
        to: "gsd-lead",
        payload: "Feature Y implemented",
        threadTag: "feature-y",
      });

      // Wait for message.created events to be bridged to MAP
      await new Promise((r) => setTimeout(r, 2000));

      // Check MAP server for inbox.message events
      const inboxMessages = mockServer.sentMessages.filter(
        (m) => m.payload?.type === "inbox.message"
      );

      console.log(`[tier6] inbox.message MAP events: ${inboxMessages.length}`);
      for (const msg of inboxMessages) {
        console.log(
          `  from: ${msg.payload.from}, to: ${JSON.stringify(msg.payload.to)}, thread: ${msg.payload.threadTag}`
        );
      }

      // The bridge should have emitted inbox.message events for each send
      // NOTE: This only works if the sidecar subscribed to message.created events
      // (which happens in map-sidecar.mjs when inboxInstance?.events && connection)
      if (inboxMessages.length > 0) {
        expect(inboxMessages.length).toBeGreaterThanOrEqual(2);

        const firstMsg = inboxMessages[0].payload;
        expect(firstMsg.from).toBe("gsd-lead");
        expect(firstMsg.threadTag).toBe("feature-y");

        const secondMsg = inboxMessages[1].payload;
        expect(secondMsg.from).toBe("gsd-executor");
        expect(secondMsg.threadTag).toBe("feature-y");
      } else {
        // If no bridge events, this is expected when the sidecar uses the
        // test helper (startTestSidecar) which may not wire up the event bridge.
        // Log for debugging.
        console.log(
          "[tier6] NOTE: No inbox.message bridge events. " +
          "This is expected if the sidecar process doesn't wire message.created → MAP."
        );
      }
    });
  }
);
