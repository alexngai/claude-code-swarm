import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readConfig, resolveScope, resolveTeamName, DEFAULTS } from "../config.mjs";
import { makeTmpDir, writeFile, cleanupTmpDir } from "./helpers.mjs";

describe("config", () => {
  describe("DEFAULTS", () => {
    it("exports expected default values", () => {
      expect(DEFAULTS.mapServer).toBe("ws://localhost:8080");
      expect(DEFAULTS.mapScope).toBe("swarm:default");
      expect(DEFAULTS.mapSystemId).toBe("system-claude-swarm");
      expect(DEFAULTS.mapSidecar).toBe("session");
      expect(DEFAULTS.sessionlogSync).toBe("off");
    });
  });

  describe("readConfig", () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("reads and parses a valid config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "get-shit-done",
        map: { enabled: true, server: "ws://example.com:9090" },
      }));
      const config = readConfig(configPath);
      expect(config.template).toBe("get-shit-done");
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://example.com:9090");
    });

    it("normalizes map fields with defaults for missing optional fields", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { enabled: true },
      }));
      const config = readConfig(configPath);
      expect(config.map.server).toBe(DEFAULTS.mapServer);
      expect(config.map.scope).toBe("");
      expect(config.map.systemId).toBe(DEFAULTS.mapSystemId);
      expect(config.map.sidecar).toBe(DEFAULTS.mapSidecar);
    });

    it("normalizes sessionlog fields with defaults", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "test" }));
      const config = readConfig(configPath);
      expect(config.sessionlog.enabled).toBe(false);
      expect(config.sessionlog.sync).toBe("off");
    });

    it("returns defaults when file does not exist", () => {
      const config = readConfig(path.join(tmpDir, "nonexistent.json"));
      expect(config.template).toBe("");
      expect(config.map.enabled).toBe(false);
      expect(config.sessionlog.enabled).toBe(false);
    });

    it("returns defaults when file contains invalid JSON", () => {
      const configPath = writeFile(tmpDir, "config.json", "not json{{{");
      const config = readConfig(configPath);
      expect(config.template).toBe("");
      expect(config.map.enabled).toBe(false);
    });

    it("returns defaults when file is empty", () => {
      const configPath = writeFile(tmpDir, "config.json", "");
      const config = readConfig(configPath);
      expect(config.template).toBe("");
    });

    it("handles config with only template field", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "my-team" }));
      const config = readConfig(configPath);
      expect(config.template).toBe("my-team");
      expect(config.map.enabled).toBe(false);
    });

    it("preserves explicit scope", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { enabled: true, scope: "custom:scope" },
      }));
      const config = readConfig(configPath);
      expect(config.map.scope).toBe("custom:scope");
    });
  });

  describe("resolveScope", () => {
    it("returns explicit scope when config.map.scope is set", () => {
      expect(resolveScope({ map: { scope: "custom:scope" }, template: "test" })).toBe("custom:scope");
    });

    it("returns swarm:<template> when template is set but scope is not", () => {
      expect(resolveScope({ map: { scope: "" }, template: "get-shit-done" })).toBe("swarm:get-shit-done");
    });

    it("returns swarm:default when neither scope nor template is set", () => {
      expect(resolveScope({ map: { scope: "" }, template: "" })).toBe("swarm:default");
    });

    it("prioritizes explicit scope over template-derived scope", () => {
      expect(resolveScope({ map: { scope: "my:scope" }, template: "test" })).toBe("my:scope");
    });
  });

  describe("resolveTeamName", () => {
    it("strips swarm: prefix from resolved scope", () => {
      expect(resolveTeamName({ map: { scope: "swarm:my-team" }, template: "" })).toBe("my-team");
    });

    it("returns template name when no explicit scope", () => {
      expect(resolveTeamName({ map: { scope: "" }, template: "get-shit-done" })).toBe("get-shit-done");
    });

    it("returns 'default' when no scope or template", () => {
      expect(resolveTeamName({ map: { scope: "" }, template: "" })).toBe("default");
    });
  });
});
