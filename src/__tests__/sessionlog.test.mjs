import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { findActiveSession, buildTrajectoryCheckpoint } from "../sessionlog.mjs";
import { makeTmpDir, writeFile, makeConfig, cleanupTmpDir } from "./helpers.mjs";

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
      tokenUsage: { input: 1000, output: 500 },
      extraField: "extra",
    };

    it("sets agentId to teamName-sidecar", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.agentId).toBe("test-team-sidecar");
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

    it("builds human-readable label", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.label).toContain("Turn turn-5");
      expect(cp.label).toContain("step 10");
    });

    it("includes base metadata at lifecycle level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.metadata.phase).toBe("active");
      expect(cp.metadata.turnId).toBe("turn-5");
      expect(cp.metadata.startedAt).toBe("2024-01-01T00:00:00Z");
      expect(cp.metadata.stepCount).toBeUndefined();
    });

    it("includes metrics at metrics level", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "metrics", makeConfig());
      expect(cp.metadata.stepCount).toBe(10);
      expect(cp.metadata.filesTouched).toEqual(["a.js", "b.js"]);
      expect(cp.metadata.tokenUsage).toEqual({ input: 1000, output: 500 });
      expect(cp.metadata.lastCheckpointID).toBe("cp-42");
    });

    it("includes all state fields at full level", () => {
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

    it("sets sessionId from state.sessionID", () => {
      const cp = buildTrajectoryCheckpoint(baseState, "lifecycle", makeConfig());
      expect(cp.sessionId).toBe("sess-123");
    });
  });
});
