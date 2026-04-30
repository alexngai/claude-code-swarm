/**
 * Integration tests for the scope-check hook.
 * Runs the hook as a subprocess, pipes stdin JSON, checks exit code + stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOOK = path.resolve(
  new URL("..", import.meta.url).pathname,
  "..",
  "scripts",
  "scope-check.mjs"
);

function runHook({ toolName, scopeFile, roleName } = {}) {
  const env = { ...process.env };
  if (scopeFile) env.SCOPE_FILE = scopeFile;
  if (roleName) env.ROLE_NAME = roleName;

  const stdin = JSON.stringify({
    tool_name: toolName,
    tool_input: {},
  });

  const result = spawnSync("node", [HOOK], {
    input: stdin,
    env,
    encoding: "utf-8",
    timeout: 5000,
  });
  return {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe("scope-check hook", () => {
  let tmpDir;
  let scopeFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-scope-"));
    scopeFile = path.join(tmpDir, "scope.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeScope(doc) {
    fs.writeFileSync(scopeFile, JSON.stringify(doc));
  }

  // ─── Allow cases ───

  it("allows non-MCP tool calls (defensive)", () => {
    writeScope({ role: "r", scope: [] });
    const { exitCode } = runHook({
      toolName: "Read",
      scopeFile,
      roleName: "reviewer",
    });
    expect(exitCode).toBe(0);
  });

  it("allows when no SCOPE_FILE is set", () => {
    const { exitCode } = runHook({ toolName: "mcp__ast-grep__search" });
    expect(exitCode).toBe(0);
  });

  it("allows when scope file is missing (fail-open)", () => {
    const { exitCode, stderr } = runHook({
      toolName: "mcp__ast-grep__search",
      scopeFile: path.join(tmpDir, "does-not-exist.json"),
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("could not read scope file");
  });

  it("allows when the server is not in scope (Claude Code's allowlist gates elsewhere)", () => {
    writeScope({
      role: "r",
      scope: [{ server: "opentasks" }],
    });
    const { exitCode } = runHook({
      toolName: "mcp__chrome-devtools__navigate",
      scopeFile,
    });
    expect(exitCode).toBe(0);
  });

  it("allows a tool within an allowlist", () => {
    writeScope({
      role: "r",
      scope: [{ server: "chrome-devtools", tools: ["navigate", "screenshot"] }],
    });
    const { exitCode } = runHook({
      toolName: "mcp__chrome-devtools__navigate",
      scopeFile,
      roleName: "reviewer",
    });
    expect(exitCode).toBe(0);
  });

  it("allows a tool when server is in scope with no restrictions", () => {
    writeScope({
      role: "r",
      scope: [{ server: "ast-grep" }],
    });
    const { exitCode } = runHook({
      toolName: "mcp__ast-grep__search",
      scopeFile,
    });
    expect(exitCode).toBe(0);
  });

  // ─── Deny cases ───

  it("denies a tool outside the allowlist", () => {
    writeScope({
      role: "r",
      scope: [{ server: "chrome-devtools", tools: ["navigate"] }],
    });
    const { exitCode, stderr } = runHook({
      toolName: "mcp__chrome-devtools__evaluate_script",
      scopeFile,
      roleName: "reviewer",
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not in the scope allowlist");
    expect(stderr).toContain("reviewer");
  });

  it("denies a tool in an exclude list", () => {
    writeScope({
      role: "r",
      scope: [{ server: "ast-grep", exclude: ["dangerous_replace"] }],
    });
    const { exitCode, stderr } = runHook({
      toolName: "mcp__ast-grep__dangerous_replace",
      scopeFile,
      roleName: "reviewer",
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("scope exclude");
  });

  it("exclude is checked before allowlist", () => {
    writeScope({
      role: "r",
      scope: [
        {
          server: "ast-grep",
          tools: ["search", "dangerous_replace"], // mistakenly allows
          exclude: ["dangerous_replace"], // but also excludes
        },
      ],
    });
    const { exitCode, stderr } = runHook({
      toolName: "mcp__ast-grep__dangerous_replace",
      scopeFile,
      roleName: "reviewer",
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("exclude");
  });

  // ─── Edge cases ───

  it("handles malformed stdin as allow (fail-open on protocol glitches)", () => {
    writeScope({ role: "r", scope: [] });
    const result = spawnSync("node", [HOOK], {
      input: "{not json]",
      env: { ...process.env, SCOPE_FILE: scopeFile },
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });

  it("handles tool names with multiple underscores correctly", () => {
    // mcp__server__tool_with_underscores → server=server, tool=tool_with_underscores
    writeScope({
      role: "r",
      scope: [{ server: "my-server", tools: ["tool_with_underscores"] }],
    });
    const { exitCode } = runHook({
      toolName: "mcp__my-server__tool_with_underscores",
      scopeFile,
    });
    expect(exitCode).toBe(0);
  });

  it("derives role from scope file when ROLE_NAME env missing", () => {
    writeScope({
      role: "fallback-role",
      scope: [{ server: "x", tools: ["a"] }],
    });
    const { stderr } = runHook({
      toolName: "mcp__x__b",
      scopeFile,
      // no roleName
    });
    expect(stderr).toContain("fallback-role");
  });
});
