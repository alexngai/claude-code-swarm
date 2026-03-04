/**
 * Tier 3: Team Coordination Tests
 *
 * Verifies full team launch with a concrete goal: Skill invocation,
 * TeamCreate, and Agent spawn. TaskCreate and multi-agent coordination
 * happen inside subagents and aren't visible in the parent stream,
 * so those are logged but not hard-asserted.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runClaude, CLI_AVAILABLE } from "./helpers/cli.mjs";
import {
  findToolCalls,
  extractToolCalls,
  getResult,
} from "./helpers/assertions.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace } from "./helpers/cleanup.mjs";

describe.skipIf(!CLI_AVAILABLE)(
  "tier3: team coordination",
  { timeout: 600_000 },
  () => {
    let workspace;
    let messages;
    let toolNames;
    let result;

    beforeAll(async () => {
      workspace = createWorkspace({
        config: { template: "gsd" },
        files: {
          "README.md": "# Test Project\nA simple test project.\n",
        },
      });

      const run = await runClaude(
        'Please run /swarm gsd with goal: Create a Python script called hello.py that prints "Hello, World!"',
        {
          cwd: workspace.dir,
          maxBudgetUsd: 5.0,
          maxTurns: 30,
          timeout: 300_000,
          label: "tier3-coordination",
        }
      );
      messages = run.messages;
      toolNames = extractToolCalls(messages).map((tc) => tc.name);
      result = getResult(messages);
      console.log(`[tier3] tool calls: ${toolNames.join(", ")}`);
      console.log(`[tier3] result: ${result?.subtype || "success"}, cost: $${result?.total_cost_usd?.toFixed(2) || "?"}`);
    });

    afterAll(() => {
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
    });

    it("invokes the Skill tool for /swarm", () => {
      const skillCalls = findToolCalls(messages, "Skill");
      expect(skillCalls.length).toBeGreaterThan(0);
    });

    it("calls TeamCreate to set up the team", () => {
      expect(toolNames).toContain("TeamCreate");
    });

    it("spawns a coordinator agent with team_name", () => {
      const agentCalls = findToolCalls(messages, "Agent");
      expect(agentCalls.length).toBeGreaterThanOrEqual(1);
      expect(agentCalls.some((ac) => ac.team_name)).toBe(true);
    });

    it("logs subagent activity (informational)", () => {
      // TaskCreate and multi-agent spawning happen inside subagents
      // and aren't visible in the parent's stream-json output.
      const taskCreates = findToolCalls(messages, "TaskCreate");
      const agentCalls = findToolCalls(messages, "Agent");
      console.log(
        `[tier3] parent-visible: ${agentCalls.length} Agent call(s), ${taskCreates.length} TaskCreate call(s)`
      );
      // Always passes — this is informational
      expect(true).toBe(true);
    });
  }
);
