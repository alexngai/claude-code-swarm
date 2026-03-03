/**
 * Tier 2: Skill Invocation Tests
 *
 * Verifies the /swarm skill triggers TeamCreate and coordinator Agent spawn.
 * Uses real LLM calls with capped budget and turn limits.
 *
 * To avoid redundant LLM spend, the get-shit-done flow runs ONCE and
 * multiple assertions are checked against the same result set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { runClaude, CLI_AVAILABLE, PLUGIN_DIR } from "./helpers/cli.mjs";
import {
  findToolCalls,
  extractToolCalls,
  getResult,
} from "./helpers/assertions.mjs";
import { createWorkspace, CONFIGS } from "./helpers/workspace.mjs";
import { cleanupWorkspace } from "./helpers/cleanup.mjs";

describe.skipIf(!CLI_AVAILABLE)(
  "tier2: /swarm skill invocation (get-shit-done)",
  { timeout: 600_000 },
  () => {
    let workspace;
    let messages;
    let toolNames;

    beforeAll(async () => {
      workspace = createWorkspace({ config: CONFIGS.minimal });
      const run = await runClaude(
        "Please run /swarm get-shit-done",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 5.0,
          maxTurns: 30,
          label: "tier2-gsd",
        }
      );
      messages = run.messages;
      toolNames = extractToolCalls(messages).map((tc) => tc.name);
      console.log(`[tier2] get-shit-done tool calls: ${toolNames.join(", ")}`);
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
      expect(
        skillCalls.some(
          (sc) =>
            sc.skill === "swarm" ||
            sc.skill === "claude-code-swarm:swarm"
        )
      ).toBe(true);
    });

    it("calls TeamCreate with get-shit-done team name", () => {
      const teamCreates = findToolCalls(messages, "TeamCreate");
      expect(teamCreates.length).toBeGreaterThan(0);

      const teamNames = teamCreates.map((tc) => tc.team_name || "");
      expect(
        teamNames.some(
          (name) =>
            name === "get-shit-done" || name.includes("get-shit-done")
        )
      ).toBe(true);
    });

    it("spawns a coordinator agent with team_name", () => {
      const agentCalls = findToolCalls(messages, "Agent");
      expect(agentCalls.length).toBeGreaterThan(0);
      expect(agentCalls.some((ac) => ac.team_name)).toBe(true);
    });

    it("generates artifacts in .generated/ directory", () => {
      const workspaceGen = path.join(workspace.dir, ".generated");
      const pluginGen = path.join(PLUGIN_DIR, ".generated");

      const hasGenerated =
        (fs.existsSync(workspaceGen) &&
          fs.readdirSync(workspaceGen).length > 0) ||
        (fs.existsSync(pluginGen) && fs.readdirSync(pluginGen).length > 0);

      expect(hasGenerated).toBe(true);
    });

    it("does not produce an error result", () => {
      const result = getResult(messages);
      if (result) {
        expect(result.is_error).not.toBe(true);
      }
    });
  }
);

describe.skipIf(!CLI_AVAILABLE)(
  "tier2: /swarm skill invocation (bmad-method)",
  { timeout: 600_000 },
  () => {
    let workspace;
    let messages;

    beforeAll(async () => {
      workspace = createWorkspace({ config: CONFIGS.bmadMethod });
      const run = await runClaude(
        "Please run /swarm bmad-method",
        {
          cwd: workspace.dir,
          maxBudgetUsd: 5.0,
          maxTurns: 30,
          label: "tier2-bmad",
        }
      );
      messages = run.messages;
      const toolNames = extractToolCalls(messages).map((tc) => tc.name);
      console.log(`[tier2] bmad-method tool calls: ${toolNames.join(", ")}`);
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

    it("calls TeamCreate for bmad-method", () => {
      const teamCreates = findToolCalls(messages, "TeamCreate");
      expect(teamCreates.length).toBeGreaterThan(0);
    });
  }
);
