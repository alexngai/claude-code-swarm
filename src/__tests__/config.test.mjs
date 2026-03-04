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
        template: "gsd",
        map: { enabled: true, server: "ws://example.com:9090" },
      }));
      const config = readConfig(configPath);
      expect(config.template).toBe("gsd");
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

    it("implicitly enables MAP when map.server is configured", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://example.com:9090" },
      }));
      const config = readConfig(configPath);
      expect(config.map.enabled).toBe(true);
    });

    it("does not implicitly enable MAP when no map config is present", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
      }));
      const config = readConfig(configPath);
      expect(config.map.enabled).toBe(false);
    });
  });

  describe("resolveScope", () => {
    it("returns explicit scope when config.map.scope is set", () => {
      expect(resolveScope({ map: { scope: "custom:scope" }, template: "test" })).toBe("custom:scope");
    });

    it("returns swarm:<template> when template is set but scope is not", () => {
      expect(resolveScope({ map: { scope: "" }, template: "gsd" })).toBe("swarm:gsd");
    });

    it("returns swarm:default when neither scope nor template is set", () => {
      expect(resolveScope({ map: { scope: "" }, template: "" })).toBe("swarm:default");
    });

    it("prioritizes explicit scope over template-derived scope", () => {
      expect(resolveScope({ map: { scope: "my:scope" }, template: "test" })).toBe("my:scope");
    });
  });

  describe("env var overrides", () => {
    let tmpDir;
    const savedEnv = {};

    beforeEach(() => {
      tmpDir = makeTmpDir();
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("SWARM_")) {
          savedEnv[key] = process.env[key];
        }
      }
    });

    afterEach(() => {
      cleanupTmpDir(tmpDir);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("SWARM_")) {
          if (savedEnv[key] !== undefined) {
            process.env[key] = savedEnv[key];
          } else {
            delete process.env[key];
          }
        }
      }
      Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
    });

    it("SWARM_TEMPLATE overrides config file", () => {
      process.env.SWARM_TEMPLATE = "env-template";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "file-template",
      }));
      const config = readConfig(configPath);
      expect(config.template).toBe("env-template");
    });

    it("SWARM_MAP_ENABLED overrides config file", () => {
      process.env.SWARM_MAP_ENABLED = "true";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { enabled: false },
      }));
      const config = readConfig(configPath);
      expect(config.map.enabled).toBe(true);
    });

    it("SWARM_MAP_ENABLED handles truthy variants (1, yes)", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({}));

      process.env.SWARM_MAP_ENABLED = "1";
      expect(readConfig(configPath).map.enabled).toBe(true);

      process.env.SWARM_MAP_ENABLED = "yes";
      expect(readConfig(configPath).map.enabled).toBe(true);

      process.env.SWARM_MAP_ENABLED = "YES";
      expect(readConfig(configPath).map.enabled).toBe(true);
    });

    it("SWARM_MAP_ENABLED=false overrides true in config", () => {
      process.env.SWARM_MAP_ENABLED = "false";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { enabled: true },
      }));
      expect(readConfig(configPath).map.enabled).toBe(false);
    });

    it("SWARM_MAP_ENABLED=false disables even when server is configured", () => {
      process.env.SWARM_MAP_ENABLED = "false";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://example.com:9090" },
      }));
      expect(readConfig(configPath).map.enabled).toBe(false);
    });

    it("SWARM_MAP_SERVER implicitly enables MAP", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({}));
      const config = readConfig(configPath);
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://env-server:9090");
    });

    it("SWARM_MAP_SERVER overrides config file", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://file-server:8080" },
      }));
      expect(readConfig(configPath).map.server).toBe("ws://env-server:9090");
    });

    it("SWARM_MAP_SCOPE overrides config file", () => {
      process.env.SWARM_MAP_SCOPE = "custom:env-scope";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { scope: "custom:file-scope" },
      }));
      expect(readConfig(configPath).map.scope).toBe("custom:env-scope");
    });

    it("SWARM_MAP_SYSTEM_ID overrides config file", () => {
      process.env.SWARM_MAP_SYSTEM_ID = "env-system";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { systemId: "file-system" },
      }));
      expect(readConfig(configPath).map.systemId).toBe("env-system");
    });

    it("SWARM_MAP_SIDECAR overrides config file", () => {
      process.env.SWARM_MAP_SIDECAR = "persistent";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { sidecar: "session" },
      }));
      expect(readConfig(configPath).map.sidecar).toBe("persistent");
    });

    it("SWARM_SESSIONLOG_ENABLED overrides config file", () => {
      process.env.SWARM_SESSIONLOG_ENABLED = "true";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        sessionlog: { enabled: false },
      }));
      expect(readConfig(configPath).sessionlog.enabled).toBe(true);
    });

    it("SWARM_SESSIONLOG_SYNC overrides config file", () => {
      process.env.SWARM_SESSIONLOG_SYNC = "full";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        sessionlog: { sync: "off" },
      }));
      expect(readConfig(configPath).sessionlog.sync).toBe("full");
    });

    it("env vars override defaults when no config file exists", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      process.env.SWARM_MAP_SYSTEM_ID = "env-system";
      const config = readConfig(path.join(tmpDir, "nonexistent.json"));
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://env-server:9090");
      expect(config.map.systemId).toBe("env-system");
    });

    it("unset env vars fall through to config file values", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "file-template",
        map: { server: "ws://file-server:8080" },
      }));
      const config = readConfig(configPath);
      expect(config.template).toBe("file-template");
      expect(config.map.server).toBe("ws://file-server:8080");
    });
  });

  describe("resolveTeamName", () => {
    it("strips swarm: prefix from resolved scope", () => {
      expect(resolveTeamName({ map: { scope: "swarm:my-team" }, template: "" })).toBe("my-team");
    });

    it("returns template name when no explicit scope", () => {
      expect(resolveTeamName({ map: { scope: "" }, template: "gsd" })).toBe("gsd");
    });

    it("returns 'default' when no scope or template", () => {
      expect(resolveTeamName({ map: { scope: "" }, template: "" })).toBe("default");
    });
  });
});
