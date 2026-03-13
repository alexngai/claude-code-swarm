/**
 * Tier 6: Agent-Inbox MCP Tools Integration Test
 *
 * Verifies that when inbox.enabled is true, the agent-inbox MCP server
 * starts and exposes its tools (send_message, check_inbox, read_thread,
 * list_agents) to the live Claude Code agent.
 *
 * Gated behind LIVE_AGENT_TEST=1 (requires live Claude Code CLI).
 *
 * Run: LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier6-inbox-mcp.test.mjs
 */

import { describe, it, expect, afterAll } from "vitest";
import { runClaude, CLI_AVAILABLE } from "./helpers/cli.mjs";
import { extractToolCalls, getResult } from "./helpers/assertions.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace } from "./helpers/cleanup.mjs";

const LIVE = !!process.env.LIVE_AGENT_TEST;

// ─────────────────────────────────────────────────────────────────────────────
// Agent-Inbox MCP Server Integration
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier6: agent-inbox MCP tools",
  { timeout: 300_000 },
  () => {
    let workspace;

    afterAll(() => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
    });

    it("MCP server starts and exposes inbox tools when inbox.enabled", async () => {
      workspace = createWorkspace({
        config: {
          template: "gsd",
          inbox: { enabled: true },
        },
        files: {
          "README.md": "# MCP Tools Test\n",
        },
      });

      const run = await runClaude(
        "Say OK",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 1.0,
          maxTurns: 1,
          timeout: 120_000,
          label: "tier6-inbox-mcp-init",
        }
      );

      // Parse the init message for MCP server status and available tools
      const initMsg = run.messages.find(
        (m) => m.type === "system" && m.subtype === "init"
      );
      expect(initMsg).toBeTruthy();

      // Check MCP server is connected
      const mcpServers = initMsg.mcp_servers || [];
      const inboxServer = mcpServers.find((s) => s.name.includes("agent-inbox"));

      console.log("[tier6] MCP servers:", mcpServers.map((s) => `${s.name}:${s.status}`).join(", "));
      console.log("[tier6] inbox server:", inboxServer ? `${inboxServer.name}:${inboxServer.status}` : "NOT FOUND");

      expect(inboxServer).toBeTruthy();
      expect(inboxServer.status).toBe("connected");

      // Check inbox MCP tools are available
      const tools = initMsg.tools || [];
      const inboxTools = tools.filter((t) => t.includes("agent-inbox"));
      console.log("[tier6] inbox tools:", inboxTools);

      expect(inboxTools.length).toBeGreaterThan(0);

      // Verify expected tool names
      const expectedTools = ["send_message", "check_inbox", "read_thread", "list_agents"];
      for (const expected of expectedTools) {
        const found = inboxTools.some((t) => t.includes(expected));
        console.log(`[tier6] tool ${expected}: ${found ? "found" : "MISSING"}`);
        expect(found).toBe(true);
      }
    });

    it("agent can use check_inbox MCP tool", async () => {
      // Reuse same workspace from previous test
      if (!workspace) {
        workspace = createWorkspace({
          config: {
            template: "gsd",
            inbox: { enabled: true },
          },
          files: { "README.md": "# Test\n" },
        });
      }

      const run = await runClaude(
        "Use the check_inbox MCP tool to check for messages. Report what the tool returned.",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 1.0,
          maxTurns: 5,
          timeout: 120_000,
          label: "tier6-inbox-mcp-check",
        }
      );

      const toolCalls = extractToolCalls(run.messages);
      const inboxCalls = toolCalls.filter((tc) => tc.name.includes("check_inbox"));
      console.log("[tier6] check_inbox calls:", inboxCalls.length);
      console.log("[tier6] all tool calls:", toolCalls.map((tc) => tc.name).join(", "));

      expect(inboxCalls.length).toBeGreaterThan(0);

      // Check the result is not an error
      const result = getResult(run.messages);
      expect(result?.is_error).toBeFalsy();
    });

    it("agent can use send_message and check_inbox round-trip", async () => {
      if (!workspace) {
        workspace = createWorkspace({
          config: {
            template: "gsd",
            inbox: { enabled: true },
          },
          files: { "README.md": "# Test\n" },
        });
      }

      const run = await runClaude(
        'Use the send_message MCP tool to send a message to agent "test-agent" with the body "Hello from MCP test". ' +
        'Then use check_inbox to check the inbox for "test-agent" and report what you find.',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 1.0,
          maxTurns: 10,
          timeout: 120_000,
          label: "tier6-inbox-mcp-roundtrip",
        }
      );

      const toolCalls = extractToolCalls(run.messages);
      const sendCalls = toolCalls.filter((tc) => tc.name.includes("send_message"));
      const checkCalls = toolCalls.filter((tc) => tc.name.includes("check_inbox"));

      console.log("[tier6] send_message calls:", sendCalls.length);
      console.log("[tier6] check_inbox calls:", checkCalls.length);
      console.log("[tier6] all tools:", toolCalls.map((tc) => tc.name).join(", "));

      expect(sendCalls.length).toBeGreaterThan(0);
      expect(checkCalls.length).toBeGreaterThan(0);

      // Verify the message content was sent correctly
      const sendInput = sendCalls[0]?.input || {};
      const hasCorrectRecipient = JSON.stringify(sendInput).includes("test-agent");
      const hasCorrectBody = JSON.stringify(sendInput).includes("Hello from MCP test");
      console.log(`[tier6] correct recipient: ${hasCorrectRecipient}, correct body: ${hasCorrectBody}`);

      expect(hasCorrectRecipient || hasCorrectBody).toBe(true);

      const result = getResult(run.messages);
      expect(result?.is_error).toBeFalsy();
    });
  }
);
