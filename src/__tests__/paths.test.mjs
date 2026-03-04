import { describe, it, expect } from "vitest";
import path from "path";
import {
  SWARM_DIR, SOCKET_PATH, INBOX_PATH, PID_PATH, ROLES_PATH,
  CONFIG_PATH, TMP_DIR, TEAMS_DIR, MAP_DIR,
  teamDir, pluginDir,
} from "../paths.mjs";

describe("paths", () => {
  it("exports all expected path constants", () => {
    expect(typeof SWARM_DIR).toBe("string");
    expect(typeof CONFIG_PATH).toBe("string");
    expect(typeof TMP_DIR).toBe("string");
    expect(typeof TEAMS_DIR).toBe("string");
    expect(typeof MAP_DIR).toBe("string");
    expect(typeof SOCKET_PATH).toBe("string");
    expect(typeof INBOX_PATH).toBe("string");
    expect(typeof PID_PATH).toBe("string");
    expect(typeof ROLES_PATH).toBe("string");
  });

  it("all paths are under .swarm/claude-swarm/", () => {
    expect(CONFIG_PATH).toMatch(/^\.swarm\/claude-swarm\//);
    expect(TMP_DIR).toMatch(/^\.swarm\/claude-swarm\//);
    expect(TEAMS_DIR).toMatch(/^\.swarm\/claude-swarm\//);
    expect(MAP_DIR).toMatch(/^\.swarm\/claude-swarm\//);
    expect(SOCKET_PATH).toMatch(/^\.swarm\/claude-swarm\//);
    expect(INBOX_PATH).toMatch(/^\.swarm\/claude-swarm\//);
    expect(PID_PATH).toMatch(/^\.swarm\/claude-swarm\//);
    expect(ROLES_PATH).toMatch(/^\.swarm\/claude-swarm\//);
  });

  it("CONFIG_PATH is .swarm/claude-swarm/config.json", () => {
    expect(CONFIG_PATH).toBe(".swarm/claude-swarm/config.json");
  });

  it("TMP_DIR is .swarm/claude-swarm/tmp", () => {
    expect(TMP_DIR).toBe(".swarm/claude-swarm/tmp");
  });

  it("TEAMS_DIR is under tmp/", () => {
    expect(TEAMS_DIR).toBe(".swarm/claude-swarm/tmp/teams");
  });

  it("MAP_DIR is under tmp/", () => {
    expect(MAP_DIR).toBe(".swarm/claude-swarm/tmp/map");
  });

  it("MAP runtime files are under tmp/map/", () => {
    expect(SOCKET_PATH).toContain(".swarm/claude-swarm/tmp/map/");
    expect(INBOX_PATH).toContain(".swarm/claude-swarm/tmp/map/");
    expect(PID_PATH).toContain(".swarm/claude-swarm/tmp/map/");
    expect(ROLES_PATH).toContain(".swarm/claude-swarm/tmp/map/");
  });

  describe("teamDir", () => {
    it("returns per-template path under TEAMS_DIR", () => {
      expect(teamDir("gsd")).toBe(".swarm/claude-swarm/tmp/teams/gsd");
      expect(teamDir("bmad-method")).toBe(".swarm/claude-swarm/tmp/teams/bmad-method");
    });
  });

  describe("pluginDir", () => {
    it("resolves to the repository root (parent of src/)", () => {
      const dir = pluginDir();
      expect(dir).toContain("claude-code-swarm");
      expect(dir).not.toContain("src");
    });
  });
});
