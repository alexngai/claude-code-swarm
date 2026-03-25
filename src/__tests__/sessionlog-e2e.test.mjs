/**
 * E2E test: sessionlog lifecycle dispatch through cc-swarm plugin flow.
 *
 * Creates a real temp git repo with real config files, enables sessionlog,
 * then dispatches lifecycle events via dispatchSessionlogHook() and verifies
 * session state files on disk.
 *
 * Mocked:
 *   - resolvePackage("sessionlog") — returns the real sessionlog module from
 *     references/ (in production this resolves from global node_modules)
 *   - paths.mjs GLOBAL_CONFIG_PATH — points to tmp dir to avoid reading
 *     the user's real ~/.claude-swarm/config.json
 *   - process.cwd() — points to tmp git repo
 *
 * Real:
 *   - Git repo (git init + commit in tmp dir)
 *   - sessionlog enable() — creates .sessionlog/, .git/sessionlog-sessions/, git hooks
 *   - .swarm/claude-swarm/config.json — written to tmp dir, read by real readConfig()
 *   - readConfig() — real config resolution (reads from tmp dir)
 *   - hasStandaloneHooks() — real file read of .claude/settings.json
 *   - dispatchSessionlogHook() — real dispatch through sessionlog lifecycle handler
 *   - Session state files — real files at .git/sessionlog-sessions/<id>.json
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// Resolve the real sessionlog module from the monorepo references dir
const SESSIONLOG_PATH = path.resolve(
  import.meta.dirname, "..", "..", "..", "sessionlog"
);

let _tmpDir;
let _sessionlogMod;

// Mock resolvePackage — the only mock needed for the core dispatch.
// In production, sessionlog is resolved from global node_modules via swarmkit.
// Here we return the real module from references/.
vi.mock("../swarmkit-resolver.mjs", () => ({
  resolvePackage: vi.fn(async (name) => {
    if (name === "sessionlog") return _sessionlogMod;
    return null;
  }),
}));

// Mock GLOBAL_CONFIG_PATH to a tmp path so we don't read the user's real
// ~/.claude-swarm/config.json. CONFIG_PATH stays relative (".swarm/claude-swarm/config.json")
// and is resolved by readConfig() via path.resolve(process.cwd(), configPath).
vi.mock("../paths.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const globalTmp = mkdtempSync(join(tmpdir(), "swarm-global-"));
  return {
    ...actual,
    GLOBAL_CONFIG_PATH: join(globalTmp, "config.json"),
  };
});

// Import the function under test AFTER mocks are set up
const { dispatchSessionlogHook, hasStandaloneHooks } = await import("../sessionlog.mjs");

// ── Helpers ──────────────────────────────────────────────────────────────────

function initGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test");
  execSync("git add . && git commit -m initial", { cwd: dir, stdio: "pipe" });
}

function writeConfig(dir, config) {
  const configDir = path.join(dir, ".swarm", "claude-swarm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(config, null, 2)
  );
}

function writeClaudeSettings(dir, settings) {
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2)
  );
}

function readSessionState(dir, sessionId) {
  const stateFile = path.join(dir, ".git", "sessionlog-sessions", `${sessionId}.json`);
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sessionlog e2e: plugin dispatch lifecycle", () => {
  beforeEach(async () => {
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlog-e2e-"));
    initGitRepo(_tmpDir);

    // Load the real sessionlog module
    _sessionlogMod = await import(SESSIONLOG_PATH + "/src/index.ts");

    // Enable sessionlog in the temp repo (dirs + git hooks, no agent hooks)
    const result = await _sessionlogMod.enable({
      cwd: _tmpDir,
      agent: "claude-code",
      skipAgentHooks: true,
    });
    if (!result.enabled) {
      throw new Error(`sessionlog enable failed: ${result.errors.join(", ")}`);
    }

    // Point process.cwd() to the tmp dir — this makes:
    // - readConfig() read .swarm/claude-swarm/config.json from tmp dir
    // - hasStandaloneHooks() read .claude/settings.json from tmp dir
    // - sessionlog stores resolve .git/sessionlog-sessions/ from tmp dir
    vi.spyOn(process, "cwd").mockReturnValue(_tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(_tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("hasStandaloneHooks returns false when skipAgentHooks was used", () => {
    expect(hasStandaloneHooks()).toBe(false);
  });

  it("dispatches session-start with real config (mode: plugin)", async () => {
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off", mode: "plugin" },
    });

    await dispatchSessionlogHook("session-start", {
      session_id: "e2e-plugin-session",
      transcript_path: path.join(_tmpDir, "transcript.jsonl"),
    });

    const state = readSessionState(_tmpDir, "e2e-plugin-session");
    expect(state).not.toBeNull();
    expect(state.sessionID).toBe("e2e-plugin-session");
    expect(state.phase).toBe("idle");
  });

  it("full lifecycle: start → prompt → stop → end", async () => {
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off", mode: "plugin" },
    });

    const sessionId = "e2e-full-lifecycle";
    const transcriptPath = path.join(_tmpDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");

    // SessionStart
    await dispatchSessionlogHook("session-start", {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
    expect(readSessionState(_tmpDir, sessionId).phase).toBe("idle");

    // UserPromptSubmit (TurnStart)
    await dispatchSessionlogHook("user-prompt-submit", {
      session_id: sessionId,
      transcript_path: transcriptPath,
      prompt: "implement feature X",
    });
    let state = readSessionState(_tmpDir, sessionId);
    expect(state.phase).toBe("active");
    expect(state.firstPrompt).toBe("implement feature X");

    // Stop (TurnEnd)
    await dispatchSessionlogHook("stop", {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
    expect(readSessionState(_tmpDir, sessionId).phase).toBe("idle");

    // SessionEnd
    await dispatchSessionlogHook("session-end", {
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
    state = readSessionState(_tmpDir, sessionId);
    expect(state.phase).toBe("ended");
    expect(state.endedAt).toBeDefined();
  });

  it("standalone mode skips dispatch (real config)", async () => {
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off", mode: "standalone" },
    });

    await dispatchSessionlogHook("session-start", {
      session_id: "should-not-exist",
      transcript_path: "/tmp/transcript.jsonl",
    });

    expect(readSessionState(_tmpDir, "should-not-exist")).toBeNull();
  });

  it("auto mode defers when standalone hooks exist in .claude/settings.json", async () => {
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off", mode: "auto" },
    });

    // Write standalone sessionlog hooks to .claude/settings.json
    writeClaudeSettings(_tmpDir, {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "sessionlog hooks claude-code session-start" }],
          },
        ],
      },
    });

    await dispatchSessionlogHook("session-start", {
      session_id: "should-not-exist-auto",
      transcript_path: "/tmp/transcript.jsonl",
    });

    expect(readSessionState(_tmpDir, "should-not-exist-auto")).toBeNull();
  });

  it("auto mode dispatches when no standalone hooks exist", async () => {
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off", mode: "auto" },
    });

    // No .claude/settings.json with sessionlog hooks — auto should dispatch
    await dispatchSessionlogHook("session-start", {
      session_id: "e2e-auto-no-standalone",
      transcript_path: path.join(_tmpDir, "transcript.jsonl"),
    });

    const state = readSessionState(_tmpDir, "e2e-auto-no-standalone");
    expect(state).not.toBeNull();
    expect(state.phase).toBe("idle");
  });

  it("mode defaults to auto when not specified in config", async () => {
    // Config with no mode field — should default to "auto"
    writeConfig(_tmpDir, {
      sessionlog: { enabled: true, sync: "off" },
    });

    await dispatchSessionlogHook("session-start", {
      session_id: "e2e-default-mode",
      transcript_path: path.join(_tmpDir, "transcript.jsonl"),
    });

    // No standalone hooks → auto dispatches
    const state = readSessionState(_tmpDir, "e2e-default-mode");
    expect(state).not.toBeNull();
    expect(state.phase).toBe("idle");
  });
});
