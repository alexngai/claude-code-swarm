import { describe, it, expect } from "vitest";
import path from "path";
import {
  SOCKET_PATH, INBOX_PATH, PID_PATH, ROLES_PATH,
  CONFIG_PATH, GENERATED_DIR, MAP_DIR,
  pluginDir,
} from "../paths.mjs";

describe("paths", () => {
  it("exports all expected path constants", () => {
    expect(typeof SOCKET_PATH).toBe("string");
    expect(typeof INBOX_PATH).toBe("string");
    expect(typeof PID_PATH).toBe("string");
    expect(typeof ROLES_PATH).toBe("string");
    expect(typeof CONFIG_PATH).toBe("string");
    expect(typeof GENERATED_DIR).toBe("string");
    expect(typeof MAP_DIR).toBe("string");
  });

  it("SOCKET_PATH is under .generated/map/", () => {
    expect(SOCKET_PATH).toContain(".generated/map/");
  });

  it("INBOX_PATH is under .generated/map/", () => {
    expect(INBOX_PATH).toContain(".generated/map/");
  });

  it("PID_PATH is under .generated/map/", () => {
    expect(PID_PATH).toContain(".generated/map/");
  });

  it("ROLES_PATH is under .generated/map/", () => {
    expect(ROLES_PATH).toContain(".generated/map/");
  });

  it("CONFIG_PATH is .claude-swarm.json", () => {
    expect(CONFIG_PATH).toBe(".claude-swarm.json");
  });

  describe("pluginDir", () => {
    it("resolves to the repository root (parent of src/)", () => {
      const dir = pluginDir();
      expect(dir).toContain("claude-code-swarm");
      expect(dir).not.toContain("src");
    });
  });
});
