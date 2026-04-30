/**
 * Tier 7: Live Loadout E2E Tests
 *
 * Full end-to-end tests with a LIVE Claude Code instance to verify the
 * loadout-consumer integration designed in docs/loadout-consumer-design.md.
 *
 * These tests cover the Claude-Code-side unknowns that pure-function +
 * subprocess tests cannot prove:
 *   1. Claude Code discovers file-based sub-agents at `.claude/agents/`
 *      with the rich frontmatter we generate (mcpServers, hooks, etc.)
 *   3. PreToolUse hooks declared in sub-agent frontmatter fire, and the
 *      `env:` field propagates to the hook subprocess. This is the
 *      critical Open Verification #3 from the design doc.
 *
 * Gated behind LIVE_AGENT_TEST=1 — makes real LLM calls (~$1-2 per run).
 *
 * Run:
 *   LIVE_AGENT_TEST=1 npx vitest run --config e2e/vitest.config.e2e.mjs \
 *     e2e/tier7-loadout-live.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { runClaude, CLI_AVAILABLE, PLUGIN_DIR } from "./helpers/cli.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace } from "./helpers/cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE = !!process.env.LIVE_AGENT_TEST;

const LOADOUT_DEMO = path.resolve(
  __dirname,
  "..",
  "..",
  "openteams",
  "examples",
  "loadout-demo"
);

const DEMO_AVAILABLE = fs.existsSync(LOADOUT_DEMO);

// ────────────────────────────────────────────────────────────────
// Test 1 — Claude Code discovers generated AGENT.md sub-agents
// ────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE || !DEMO_AVAILABLE)(
  "tier7: loadout live — file-based sub-agent discovery",
  { timeout: 180_000 },
  () => {
    let workspace;

    beforeAll(async () => {
      workspace = createWorkspace({
        prefix: "swarm-loadout-live-disco-",
        config: { template: LOADOUT_DEMO },
      });

      // Materialize the loadout-demo team into .claude/agents/
      const agentsDir = path.join(workspace.dir, ".claude", "agents");
      execFileSync(
        "node",
        [
          path.join(PLUGIN_DIR, "scripts", "generate-agents.mjs"),
          LOADOUT_DEMO,
          agentsDir,
        ],
        { stdio: "ignore", timeout: 30_000 }
      );
    });

    afterAll(() => {
      if (workspace) cleanupWorkspace(workspace.dir);
    });

    it("writes AGENT.md files with expected names", () => {
      const agentsDir = path.join(workspace.dir, ".claude", "agents");
      expect(
        fs.existsSync(path.join(agentsDir, "reviewer", "AGENT.md"))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(agentsDir, "implementer", "AGENT.md"))
      ).toBe(true);
    });

    it("Claude Code accepts the frontmatter and lists our sub-agents", async () => {
      const { messages, result, logFile } = await runClaude(
        "List the names of all sub-agents available to you in this project " +
          "(look at .claude/agents/). Respond with a comma-separated list " +
          "of just the sub-agent names, nothing else.",
        {
          cwd: workspace.dir,
          maxTurns: 5,
          maxBudgetUsd: "0.30",
          label: "tier7-disco",
        }
      );

      expect(result, `see log: ${logFile}`).toBeTruthy();
      const resultText = JSON.stringify(result || {}) + JSON.stringify(messages);

      // The generated sub-agents should appear in the response.
      // Claude Code auto-resolves .claude/agents/<dir>/AGENT.md as <dir>.
      expect(
        resultText,
        `Expected Claude to list sub-agents; see log: ${logFile}`
      ).toMatch(/reviewer/i);
      expect(resultText).toMatch(/implementer/i);
    });
  }
);

// ────────────────────────────────────────────────────────────────
// Test 3 — PreToolUse hook with `env:` propagates to subprocess
//
// This is the critical Open Verification from the design doc.
// If this passes, the whole non-invasive scope-check enforcement
// strategy works. If it fails, we need a fallback (CLI args instead
// of env vars in the hook command).
// ────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !CLI_AVAILABLE)(
  "tier7: loadout live — PreToolUse hook env: in sub-agent frontmatter",
  { timeout: 180_000 },
  () => {
    let workspace;
    let probePath;
    let hookScriptPath;

    beforeAll(async () => {
      workspace = createWorkspace({
        prefix: "swarm-loadout-live-hook-",
        config: { template: "" },
      });

      probePath = path.join(workspace.dir, "hook-probe.log");
      hookScriptPath = path.join(workspace.dir, "log-env.sh");

      // Hook script: write the env vars we care about to a probe file.
      // Exit 0 (allow) so the tool call proceeds normally.
      fs.writeFileSync(
        hookScriptPath,
        [
          "#!/usr/bin/env bash",
          `echo "PROBE_KEY=\${PROBE_KEY:-MISSING}" >> "${probePath}"`,
          `echo "ROLE_NAME=\${ROLE_NAME:-MISSING}" >> "${probePath}"`,
          `echo "--tool=\${CLAUDE_TOOL_NAME:-?}" >> "${probePath}"`,
          "exit 0",
        ].join("\n"),
        { mode: 0o755 }
      );

      // Write a minimal sub-agent with a Bash PreToolUse hook that
      // uses env: to inject PROBE_KEY and ROLE_NAME.
      const agentDir = path.join(workspace.dir, ".claude", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      const agentMd = [
        "---",
        "name: probe-agent",
        'description: "Probe agent for hook env: verification"',
        "tools:",
        "  - Bash",
        "hooks:",
        "  PreToolUse:",
        '    - matcher: "Bash"',
        "      hooks:",
        "        - type: command",
        `          command: ${hookScriptPath}`,
        "          env:",
        "            PROBE_KEY: probe-value-xyz-42",
        "            ROLE_NAME: probe-role",
        "---",
        "",
        "# Probe Agent",
        "",
        "When asked to run a shell command, run it via Bash. No commentary.",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(agentDir, "probe-agent.md"), agentMd);
    });

    afterAll(() => {
      if (workspace) cleanupWorkspace(workspace.dir);
    });

    it("invokes a Bash-using sub-agent and captures hook env vars", async () => {
      const { messages, result, logFile } = await runClaude(
        "Use the Task tool to delegate to sub-agent 'probe-agent' with the task: " +
          "\"Run the shell command: echo hello-from-probe\"",
        {
          cwd: workspace.dir,
          maxTurns: 6,
          maxBudgetUsd: "0.30",
          label: "tier7-hook-env",
        }
      );

      expect(result, `see log: ${logFile}`).toBeTruthy();

      // The hook should have fired at least once — probe log must exist and
      // contain the specific env value we set in the sub-agent frontmatter.
      expect(
        fs.existsSync(probePath),
        `Hook probe log missing at ${probePath}. See runClaude log: ${logFile}. ` +
          `This is the key assertion — if the file is absent, Claude Code did not ` +
          `invoke the PreToolUse hook from the sub-agent's frontmatter.`
      ).toBe(true);

      const probe = fs.readFileSync(probePath, "utf-8");
      expect(
        probe,
        `Env var PROBE_KEY did not propagate. Probe contents: ${probe}. ` +
          `Log: ${logFile}. This means Claude Code does not honor \`env:\` in ` +
          `sub-agent hook frontmatter, and we need the CLI-arg fallback.`
      ).toContain("PROBE_KEY=probe-value-xyz-42");
      expect(probe).toContain("ROLE_NAME=probe-role");
    });
  }
);
