/**
 * Tier 1: Hook Integration Tests
 *
 * Verifies SessionStart hooks fire correctly via the plugin.
 * Uses --init-only for crash-only checks ($0 cost) and minimal
 * -p calls for content assertions (~$0.05/test).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { runClaude, runInitOnly, CLI_AVAILABLE, PLUGIN_DIR } from "./helpers/cli.mjs";
import { getResult, getHookOutput, getAssistantText } from "./helpers/assertions.mjs";
import { createWorkspace, CONFIGS } from "./helpers/workspace.mjs";

/**
 * Run a raw claude command with stdin=/dev/null for diagnostics.
 */
function rawExec(args, options = {}) {
  const { timeout = 15_000 } = options;
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? 143 : (code || 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message, killed: false });
    });
  });
}

/**
 * Run a minimal -p call to trigger hooks and capture output.
 * Uses stream-json to get the full message stream including hook output.
 */
function runWithHooks(cwd) {
  return runClaude(
    "Respond with just the word OK. Do not use any tools.",
    { cwd, maxBudgetUsd: 0.10, maxTurns: 1, timeout: 30_000 }
  );
}

/**
 * Get all text from the session — hook output, assistant text, raw stdout/stderr.
 */
function getAllSessionText(run) {
  const parts = [];
  if (run.stdout) parts.push(run.stdout);
  if (run.stderr) parts.push(run.stderr);
  if (run.messages?.length > 0) {
    parts.push(getHookOutput(run.messages));
    parts.push(getAssistantText(run.messages));
  }
  return parts.join("\n");
}

/**
 * Diagnostics — verify the CLI invocation mechanism works.
 */
describe.skipIf(!CLI_AVAILABLE)("tier1: diagnostics", { timeout: 120_000 }, () => {
  it("claude --version works via spawn", async () => {
    const r = await rawExec(["--version"]);
    console.log("[diag] --version:", { exitCode: r.exitCode, stdout: r.stdout.trim(), killed: r.killed });
    expect(r.killed).toBe(false);
    expect(r.stdout).toContain("Claude Code");
  });

  it("claude -p works without plugin", async () => {
    const r = await rawExec(
      ["-p", "say OK", "--output-format", "json", "--no-session-persistence", "--max-turns", "1"],
      { timeout: 30_000 }
    );
    console.log("[diag] -p no plugin:", { exitCode: r.exitCode, stdoutLen: r.stdout.length, killed: r.killed });
    expect(r.killed).toBe(false);
  });

  it("claude -p works with plugin and stream-json", async () => {
    const r = await rawExec(
      ["-p", "say OK", "--output-format", "stream-json", "--verbose",
       "--no-session-persistence", "--dangerously-skip-permissions",
       "--plugin-dir", PLUGIN_DIR, "--max-turns", "1"],
      { timeout: 60_000 }
    );
    console.log("[diag] stream-json:", { exitCode: r.exitCode, stdoutLen: r.stdout.length, killed: r.killed });
    console.log("[diag] first 500 chars:", r.stdout.slice(0, 500));
    console.log("[diag] line count:", r.stdout.split("\n").filter(l => l.trim()).length);
    expect(r.killed).toBe(false);
  });
});

describe.skipIf(!CLI_AVAILABLE)("tier1: SessionStart hook integration", { timeout: 120_000 }, () => {
  let workspace;

  afterEach(() => {
    workspace?.cleanup();
  });

  it("session starts without crashing when no config file exists", async () => {
    workspace = createWorkspace();
    const run = await runInitOnly({ cwd: workspace.dir });
    expect(run.exitCode).toBe(0);
  });

  it("hook output mentions configured template name", async () => {
    workspace = createWorkspace({ config: CONFIGS.minimal });
    const run = await runWithHooks(workspace.dir);
    const text = getAllSessionText(run);
    console.log("[tier1] template text length:", text.length);
    console.log("[tier1] messages:", run.messages.length, "types:", run.messages.map(m => m.subtype || m.type).join(", "));
    expect(text).toContain("gsd");
  });

  it("hook output mentions /swarm command", async () => {
    workspace = createWorkspace({ config: CONFIGS.minimal });
    const run = await runWithHooks(workspace.dir);
    const text = getAllSessionText(run);
    expect(text).toContain("/swarm");
  });

  it("hook output mentions bmad-method when configured", async () => {
    workspace = createWorkspace({ config: CONFIGS.bmadMethod });
    const run = await runWithHooks(workspace.dir);
    const text = getAllSessionText(run);
    expect(text).toContain("bmad-method");
  });

  it("hook output mentions MAP when enabled", async () => {
    workspace = createWorkspace({ config: CONFIGS.withMap });
    const run = await runWithHooks(workspace.dir);
    const text = getAllSessionText(run);
    expect(text.toLowerCase()).toContain("map");
  });

  it("session starts successfully even with invalid template", async () => {
    workspace = createWorkspace({
      config: { template: "nonexistent-template-xyz" },
    });
    const run = await runWithHooks(workspace.dir);
    expect(run.exitCode).not.toBe(143); // not killed
    const text = getAllSessionText(run);
    // Should still mention /swarm as fallback
    expect(text).toContain("/swarm");
  });

  it("hook output lists available templates when no template set", async () => {
    workspace = createWorkspace({ config: CONFIGS.noTemplate });
    const run = await runWithHooks(workspace.dir);
    const text = getAllSessionText(run);
    // Should mention at least one built-in template
    const mentionsTemplate =
      text.includes("gsd") || text.includes("bmad-method");
    expect(mentionsTemplate).toBe(true);
  });
});
