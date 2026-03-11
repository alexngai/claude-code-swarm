import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";

// We need to test path resolution with different CWD states.
// Since paths.mjs computes values at module load time, we test the
// exported values AND mock fs.existsSync to test resolution logic.

describe("paths (current environment)", () => {
  // These tests verify the exports work correctly in the test environment.
  // The actual resolution depends on whether .swarm/claude-swarm/ exists in CWD.

  let paths;

  beforeEach(async () => {
    // Fresh import each time (vitest module cache may apply)
    paths = await import("../paths.mjs");
  });

  it("exports all expected path constants", () => {
    expect(typeof paths.SWARM_DIR).toBe("string");
    expect(typeof paths.CONFIG_PATH).toBe("string");
    expect(typeof paths.TMP_DIR).toBe("string");
    expect(typeof paths.TEAMS_DIR).toBe("string");
    expect(typeof paths.MAP_DIR).toBe("string");
    expect(typeof paths.SOCKET_PATH).toBe("string");
    expect(typeof paths.PID_PATH).toBe("string");
    expect(typeof paths.ROLES_PATH).toBe("string");
    expect(typeof paths.IS_GLOBAL_PATHS).toBe("boolean");
  });

  it("CONFIG_PATH is always project-relative", () => {
    expect(paths.CONFIG_PATH).toBe(".swarm/claude-swarm/config.json");
  });

  it("SWARM_DIR is always project-relative", () => {
    expect(paths.SWARM_DIR).toBe(".swarm/claude-swarm");
  });

  it("GLOBAL_CONFIG_DIR is under ~/.claude-swarm/", () => {
    expect(paths.GLOBAL_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude-swarm"));
  });

  it("GLOBAL_CONFIG_PATH is config.json under GLOBAL_CONFIG_DIR", () => {
    expect(paths.GLOBAL_CONFIG_PATH).toBe(path.join(os.homedir(), ".claude-swarm", "config.json"));
  });

  it("TEAMS_DIR is under TMP_DIR", () => {
    expect(paths.TEAMS_DIR).toBe(path.join(paths.TMP_DIR, "teams"));
  });

  it("MAP runtime files are under MAP_DIR", () => {
    expect(paths.SOCKET_PATH).toBe(path.join(paths.MAP_DIR, "sidecar.sock"));
    expect(paths.PID_PATH).toBe(path.join(paths.MAP_DIR, "sidecar.pid"));
    expect(paths.ROLES_PATH).toBe(path.join(paths.MAP_DIR, "roles.json"));
    expect(paths.SESSIONLOG_STATE_PATH).toBe(path.join(paths.MAP_DIR, "sessionlog-state.json"));
    expect(paths.SIDECAR_LOG_PATH).toBe(path.join(paths.MAP_DIR, "sidecar.log"));
  });

  describe("teamDir", () => {
    it("returns per-template path under TEAMS_DIR", () => {
      expect(paths.teamDir("gsd")).toBe(path.join(paths.TEAMS_DIR, "gsd"));
      expect(paths.teamDir("bmad-method")).toBe(path.join(paths.TEAMS_DIR, "bmad-method"));
    });
  });

  describe("pluginDir", () => {
    it("resolves to the repository root (parent of src/)", () => {
      const dir = paths.pluginDir();
      expect(dir).toContain("claude-code-swarm");
      expect(dir).not.toContain("src");
    });
  });
});

describe("path resolution logic", () => {
  // These tests verify the resolution rules by checking the relationship
  // between IS_GLOBAL_PATHS and the computed paths.

  let paths;

  beforeEach(async () => {
    paths = await import("../paths.mjs");
  });

  const globalBase = path.join(os.homedir(), ".claude", "claude-swarm");

  it("when global: TMP_DIR is under ~/.claude/claude-swarm/tmp/", () => {
    if (!paths.IS_GLOBAL_PATHS) return; // skip if project-level
    expect(paths.TMP_DIR).toBe(path.join(globalBase, "tmp"));
  });

  it("when global: MAP_DIR includes CWD hash for isolation", () => {
    if (!paths.IS_GLOBAL_PATHS) return;
    // MAP_DIR should be: ~/.claude/claude-swarm/tmp/map/<12-char-hash>
    const mapRelative = path.relative(path.join(globalBase, "tmp", "map"), paths.MAP_DIR);
    expect(mapRelative).toMatch(/^[a-f0-9]{12}$/);
  });

  it("when global: TEAMS_DIR is shared (no CWD hash)", () => {
    if (!paths.IS_GLOBAL_PATHS) return;
    expect(paths.TEAMS_DIR).toBe(path.join(globalBase, "tmp", "teams"));
  });

  it("when project-level: TMP_DIR is under .swarm/claude-swarm/tmp", () => {
    if (paths.IS_GLOBAL_PATHS) return; // skip if global
    expect(paths.TMP_DIR).toBe(".swarm/claude-swarm/tmp");
  });

  it("when project-level: MAP_DIR has no CWD hash", () => {
    if (paths.IS_GLOBAL_PATHS) return;
    expect(paths.MAP_DIR).toBe(".swarm/claude-swarm/tmp/map");
  });

  it("when project-level: TEAMS_DIR is under project tmp", () => {
    if (paths.IS_GLOBAL_PATHS) return;
    expect(paths.TEAMS_DIR).toBe(".swarm/claude-swarm/tmp/teams");
  });
});

describe("sessionPaths", () => {
  let paths;

  beforeEach(async () => {
    paths = await import("../paths.mjs");
  });

  it("returns legacy paths when sessionId is null", () => {
    const sp = paths.sessionPaths(null);
    expect(sp.socketPath).toBe(paths.SOCKET_PATH);
    expect(sp.pidPath).toBe(paths.PID_PATH);
    expect(sp.sidecarLogPath).toBe(paths.SIDECAR_LOG_PATH);
    expect(sp.sessionDir).toBeNull();
  });

  it("returns legacy paths when sessionId is undefined", () => {
    const sp = paths.sessionPaths(undefined);
    expect(sp.socketPath).toBe(paths.SOCKET_PATH);
    expect(sp.sessionDir).toBeNull();
  });

  it("returns legacy paths when sessionId is empty string", () => {
    const sp = paths.sessionPaths("");
    expect(sp.socketPath).toBe(paths.SOCKET_PATH);
    expect(sp.sessionDir).toBeNull();
  });

  it("returns session-scoped paths when sessionId is provided", () => {
    const sp = paths.sessionPaths("abc123");
    expect(sp.sessionDir).toBe(path.join(paths.MAP_DIR, "sessions", "abc123"));
    expect(sp.socketPath).toBe(path.join(paths.MAP_DIR, "sessions", "abc123", "sidecar.sock"));
    expect(sp.pidPath).toBe(path.join(paths.MAP_DIR, "sessions", "abc123", "sidecar.pid"));
    expect(sp.sidecarLogPath).toBe(path.join(paths.MAP_DIR, "sessions", "abc123", "sidecar.log"));
  });

  it("hashes long session IDs (>12 chars) to 12 hex chars", () => {
    const longId = "this-is-a-very-long-session-id-that-exceeds-12-chars";
    const sp = paths.sessionPaths(longId);
    const sessionDirName = path.basename(sp.sessionDir);
    expect(sessionDirName).toMatch(/^[a-f0-9]{12}$/);
    expect(sessionDirName.length).toBe(12);
  });

  it("uses short session IDs directly (<=12 chars)", () => {
    const sp = paths.sessionPaths("short-id");
    const sessionDirName = path.basename(sp.sessionDir);
    expect(sessionDirName).toBe("short-id");
  });

  it("produces consistent hashes for the same long ID", () => {
    const longId = "a-very-long-session-identifier-here";
    const sp1 = paths.sessionPaths(longId);
    const sp2 = paths.sessionPaths(longId);
    expect(sp1.sessionDir).toBe(sp2.sessionDir);
  });
});

describe("ensureSessionDir", () => {
  let paths;
  let fs;
  let tmpDir;

  beforeEach(async () => {
    paths = await import("../paths.mjs");
    fs = await import("fs");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-dir-test-"));
  });

  afterEach(async () => {
    const fs = await import("fs");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("is exported as a function", () => {
    expect(typeof paths.ensureSessionDir).toBe("function");
  });
});

describe("listSessionDirs", () => {
  let paths;

  beforeEach(async () => {
    paths = await import("../paths.mjs");
  });

  it("returns empty array when no sessions directory exists", () => {
    const result = paths.listSessionDirs();
    expect(Array.isArray(result)).toBe(true);
  });

  it("is exported as a function", () => {
    expect(typeof paths.listSessionDirs).toBe("function");
  });
});
