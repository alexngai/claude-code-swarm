import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { findActiveSession, buildTrajectoryCheckpoint, ensureSessionlogEnabled, checkSessionlogStatus, dispatchSessionlogHook } from "../sessionlog.mjs";
import { makeTmpDir, writeFile, makeConfig, cleanupTmpDir } from "./helpers.mjs";

// Mock child_process for ensureSessionlogEnabled tests
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
  };
});

// Mock swarmkit-resolver for resolvePackage
vi.mock("../swarmkit-resolver.mjs", () => ({
  resolvePackage: vi.fn().mockResolvedValue(null),
}));

// Mock config — preserve resolveTeamName/resolveScope for buildTrajectoryCheckpoint tests,
// override readConfig for dispatchSessionlogHook mode tests
vi.mock("../config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readConfig: vi.fn(() => ({
      sessionlog: { enabled: true, sync: "off", mode: "plugin" },
    })),
  };
});

describe("sessionlog", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  describe("findActiveSession", () => {
    it("returns null when directory does not exist", () => {
      expect(findActiveSession(path.join(tmpDir, "nope"))).toBeNull();
    });

    it("returns null when directory is empty", () => {
      const dir = path.join(tmpDir, "sessions");
      fs.mkdirSync(dir);
      expect(findActiveSession(dir)).toBeNull();
    });

    it("returns null when all sessions have phase 'ended'", () => {
      const dir = path.join(tmpDir, "sessions");
      writeFile(dir, "s1.json", JSON.stringify({ phase: "ended", sessionID: "s1" }));
      writeFile(dir, "s2.json", JSON.stringify({ phase: "ended", sessionID: "s2" }));
      expect(findActiveSession(dir)).toBeNull();
    });

    it("returns the active (non-ended) session", () => {
      const dir = path.join(tmpDir, "sessions");
      writeFile(dir, "s1.json", JSON.stringify({ phase: "ended", sessionID: "s1" }));
      writeFile(dir, "s2.json", JSON.stringify({ phase: "active", sessionID: "s2" }));
      const session = findActiveSession(dir);
      expect(session.sessionID).toBe("s2");
    });

    it("returns the most recent active session by lastInteractionTime", () => {
      const dir = path.join(tmpDir, "sessions");
      writeFile(dir, "s1.json", JSON.stringify({
        phase: "active", sessionID: "s1", lastInteractionTime: "2024-01-01T00:00:00Z",
      }));
      writeFile(dir, "s2.json", JSON.stringify({
        phase: "active", sessionID: "s2", lastInteractionTime: "2024-06-01T00:00:00Z",
      }));
      const session = findActiveSession(dir);
      expect(session.sessionID).toBe("s2");
    });

    it("skips malformed JSON files", () => {
      const dir = path.join(tmpDir, "sessions");
      writeFile(dir, "bad.json", "not valid json");
      writeFile(dir, "good.json", JSON.stringify({ phase: "active", sessionID: "good" }));
      const session = findActiveSession(dir);
      expect(session.sessionID).toBe("good");
    });

    it("skips non-json files", () => {
      const dir = path.join(tmpDir, "sessions");
      writeFile(dir, "readme.txt", "not a session");
      expect(findActiveSession(dir)).toBeNull();
    });
  });

  describe("buildTrajectoryCheckpoint", () => {
    const baseState = {
      sessionID: "sess-123",
      phase: "active",
      turnID: "turn-5",
      startedAt: "2024-01-01T00:00:00Z",
      stepCount: 10,
      filesTouched: ["a.js", "b.js"],
      lastCheckpointID: "cp-42",
      turnCheckpointIDs: ["cp-40", "cp-41", "cp-42"],
      tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 50, cacheReadTokens: 200, apiCallCount: 3 },
      extraField: "extra",
    };

    it("sets agent to teamName-sidecar (wire format)", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.agent).toBe("test-team-sidecar");
    });

    it("sets session_id from state.sessionID (wire format)", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.session_id).toBe("sess-123");
    });

    it("builds checkpoint id from lastCheckpointID when available", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.id).toBe("cp-42");
    });

    it("builds fallback id when no lastCheckpointID", () => {
      const state = { ...baseState, lastCheckpointID: undefined };
      const cp = buildTrajectoryCheckpoint(state, "lifecycle", makeConfig());
      expect(cp.id).toBe("sess-123-step10");
    });

    it("builds human-readable label in metadata", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.metadata.label).toContain("Turn turn-5");
      expect(cp.metadata.label).toContain("step 10");
    });

    it("defaults files_touched and checkpoints_count at lifecycle level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.files_touched).toEqual([]);
      expect(cp.checkpoints_count).toBe(0);
      expect(cp.token_usage).toBeUndefined();
    });

    it("includes base metadata at lifecycle level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.metadata.phase).toBe("active");
      expect(cp.metadata.turnId).toBe("turn-5");
      expect(cp.metadata.startedAt).toBe("2024-01-01T00:00:00Z");
      expect(cp.metadata.stepCount).toBeUndefined();
    });

    it("promotes files_touched and token_usage to top level at metrics level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "metrics", makeConfig());
      expect(cp.files_touched).toEqual(["a.js", "b.js"]);
      expect(cp.checkpoints_count).toBe(3);
      expect(cp.token_usage).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_tokens: 50,
        cache_read_tokens: 200,
        api_call_count: 3,
      });
    });

    it("keeps stepCount and checkpoint IDs in metadata at metrics level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "metrics", makeConfig());
      expect(cp.metadata.stepCount).toBe(10);
      expect(cp.metadata.lastCheckpointID).toBe("cp-42");
      expect(cp.metadata.turnCheckpointIDs).toEqual(["cp-40", "cp-41", "cp-42"]);
    });

    it("includes all state fields in metadata at full level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "full", makeConfig());
      expect(cp.metadata.extraField).toBe("extra");
      expect(cp.metadata.stepCount).toBe(10);
    });

    it("excludes sessionID from metadata at full level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "full", makeConfig());
      expect(cp.metadata.sessionID).toBeUndefined();
    });

    it("includes endedAt when present", () => {
      const state = { ...baseState, endedAt: "2024-01-01T01:00:00Z" };
      const cp = buildTrajectoryCheckpoint(state, "lifecycle", makeConfig());
      expect(cp.metadata.endedAt).toBe("2024-01-01T01:00:00Z");
    });

    it("handles legacy tokenUsage format (input/output instead of inputTokens/outputTokens)", () => {
      const state = { ...baseState, tokenUsage: { input: 800, output: 400 } };
      const cp = buildTrajectoryCheckpoint(state, "metrics", makeConfig());
      expect(cp.token_usage.input_tokens).toBe(800);
      expect(cp.token_usage.output_tokens).toBe(400);
    });

    it("includes project name from cwd in metadata", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.metadata.project).toBeDefined();
      expect(typeof cp.metadata.project).toBe("string");
      expect(cp.metadata.project.length).toBeGreaterThan(0);
    });

    it("includes git branch as top-level wire format field", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      // branch may be null in CI/non-git environments, but should be defined
      expect("branch" in cp).toBe(true);
    });

    it("includes firstPrompt from session state when available", () => {
      const state = { ...baseState, firstPrompt: "fix the bug in server.ts" };
      const cp = buildTrajectoryCheckpoint(state, "lifecycle", makeConfig());
      expect(cp.metadata.firstPrompt).toBe("fix the bug in server.ts");
    });

    it("truncates long firstPrompt to 200 chars", () => {
      const state = { ...baseState, firstPrompt: "x".repeat(300) };
      const cp = buildTrajectoryCheckpoint(state, "lifecycle", makeConfig());
      expect(cp.metadata.firstPrompt.length).toBe(200);
    });

    it("omits firstPrompt when not in session state", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.metadata.firstPrompt).toBeUndefined();
    });

    it("includes template from config when configured", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig({ template: "gsd" }));
      expect(cp.metadata.template).toBe("gsd");
    });

    it("omits template when not configured", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig({ template: "" }));
      expect(cp.metadata.template).toBeUndefined();
    });
  });

  describe("ensureSessionlogEnabled", () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReset();
    });

    it("returns true immediately when sessionlog is already active", async () => {
      // checkSessionlogStatus calls execSync twice: `which sessionlog` and `sessionlog status`
      vi.mocked(execSync)
        .mockImplementationOnce(() => "/usr/local/bin/sessionlog") // which
        .mockImplementationOnce(() => "enabled: true\nstrategy: manual-commit"); // status
      const result = await ensureSessionlogEnabled();
      expect(result).toBe(true);
    });

    it("returns false when sessionlog is not installed", async () => {
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error("not found"); }); // which
      const result = await ensureSessionlogEnabled();
      expect(result).toBe(false);
    });

    it("attempts CLI enable when installed but not enabled and resolvePackage returns null", async () => {
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      vi.mocked(resolvePackage).mockResolvedValue(null);

      // First two calls: checkSessionlogStatus (which + status)
      // Third call: CLI fallback `sessionlog enable --agent claude-code`
      vi.mocked(execSync)
        .mockImplementationOnce(() => "/usr/local/bin/sessionlog") // which
        .mockImplementationOnce(() => "enabled: false") // status → not enabled
        .mockImplementationOnce(() => ""); // sessionlog enable succeeds
      const result = await ensureSessionlogEnabled();
      expect(result).toBe(true);
    });

    it("returns false when both programmatic and CLI enable fail", async () => {
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      vi.mocked(resolvePackage).mockResolvedValue(null);

      vi.mocked(execSync)
        .mockImplementationOnce(() => "/usr/local/bin/sessionlog") // which
        .mockImplementationOnce(() => "enabled: false") // status
        .mockImplementationOnce(() => { throw new Error("enable failed"); }); // CLI fails
      const result = await ensureSessionlogEnabled();
      expect(result).toBe(false);
    });

    it("tries programmatic API before CLI fallback", async () => {
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mockEnable = vi.fn().mockResolvedValue({ enabled: true });
      vi.mocked(resolvePackage).mockResolvedValue({ enable: mockEnable });

      vi.mocked(execSync)
        .mockImplementationOnce(() => "/usr/local/bin/sessionlog") // which
        .mockImplementationOnce(() => "enabled: false"); // status → not enabled
      const result = await ensureSessionlogEnabled();
      expect(result).toBe(true);
      expect(mockEnable).toHaveBeenCalledWith({ agent: "claude-code", skipAgentHooks: true });
    });
  });

  describe("dispatchSessionlogHook", () => {
    function mockSessionlog(overrides = {}) {
      return {
        isEnabled: vi.fn().mockResolvedValue(true),
        getAgent: vi.fn().mockReturnValue({ parseHookEvent: vi.fn().mockReturnValue({ type: "SessionStart" }) }),
        hasHookSupport: vi.fn().mockReturnValue(true),
        createLifecycleHandler: vi.fn().mockReturnValue({ dispatch: vi.fn() }),
        createSessionStore: vi.fn().mockReturnValue({}),
        createCheckpointStore: vi.fn().mockReturnValue({}),
        ...overrides,
      };
    }

    beforeEach(() => {
      vi.mocked(execSync).mockReset();
    });

    it("skips dispatch when mode is 'standalone'", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "standalone" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mod = mockSessionlog();
      vi.mocked(resolvePackage).mockResolvedValue(mod);
      await dispatchSessionlogHook("session-start", { session_id: "s1" });
      expect(mod.createLifecycleHandler().dispatch).not.toHaveBeenCalled();
    });

    it("dispatches when mode is 'plugin'", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "plugin" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mockDispatch = vi.fn();
      const mockEvent = { type: "SessionStart", sessionID: "s1" };
      const mockAgent = { parseHookEvent: vi.fn().mockReturnValue(mockEvent) };
      vi.mocked(resolvePackage).mockResolvedValue(mockSessionlog({
        getAgent: vi.fn().mockReturnValue(mockAgent),
        createLifecycleHandler: vi.fn().mockReturnValue({ dispatch: mockDispatch }),
      }));
      await dispatchSessionlogHook("session-start", { session_id: "s1" });
      expect(mockDispatch).toHaveBeenCalledWith(mockAgent, mockEvent);
    });

    it("bails silently when sessionlog package is not available", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "plugin" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      vi.mocked(resolvePackage).mockResolvedValue(null);
      await dispatchSessionlogHook("session-start", { session_id: "s1" });
    });

    it("bails when isEnabled returns false", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "plugin" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mockDispatch = vi.fn();
      vi.mocked(resolvePackage).mockResolvedValue(mockSessionlog({
        isEnabled: vi.fn().mockResolvedValue(false),
        createLifecycleHandler: vi.fn().mockReturnValue({ dispatch: mockDispatch }),
      }));
      await dispatchSessionlogHook("session-start", { session_id: "s1" });
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("bails when parseHookEvent returns null", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "plugin" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mockDispatch = vi.fn();
      vi.mocked(resolvePackage).mockResolvedValue(mockSessionlog({
        getAgent: vi.fn().mockReturnValue({ parseHookEvent: vi.fn().mockReturnValue(null) }),
        createLifecycleHandler: vi.fn().mockReturnValue({ dispatch: mockDispatch }),
      }));
      await dispatchSessionlogHook("unknown-hook", {});
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("bails when getAgent returns null", async () => {
      const { readConfig } = await import("../config.mjs");
      vi.mocked(readConfig).mockReturnValue({ sessionlog: { enabled: true, sync: "off", mode: "plugin" } });
      const { resolvePackage } = await import("../swarmkit-resolver.mjs");
      const mockDispatch = vi.fn();
      vi.mocked(resolvePackage).mockResolvedValue(mockSessionlog({
        getAgent: vi.fn().mockReturnValue(null),
        createLifecycleHandler: vi.fn().mockReturnValue({ dispatch: mockDispatch }),
      }));
      await dispatchSessionlogHook("session-start", { session_id: "s1" });
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });
});
