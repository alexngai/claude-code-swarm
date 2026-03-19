import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readConfig, resolveScope, resolveTeamName, resolveMapServer, DEFAULTS } from "../config.mjs";
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
    let noGlobal;
    beforeEach(() => {
      tmpDir = makeTmpDir();
      noGlobal = path.join(tmpDir, "no-global.json");
    });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("reads and parses a valid config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "gsd",
        map: { enabled: true, server: "ws://example.com:9090" },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("gsd");
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://example.com:9090");
    });

    it("normalizes map fields with defaults for missing optional fields", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { enabled: true },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.server).toBe(DEFAULTS.mapServer);
      expect(config.map.scope).toBe("");
      expect(config.map.systemId).toBe(DEFAULTS.mapSystemId);
      expect(config.map.sidecar).toBe(DEFAULTS.mapSidecar);
    });

    it("normalizes sessionlog fields with defaults", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "test" }));
      const config = readConfig(configPath, noGlobal);
      expect(config.sessionlog.enabled).toBe(false);
      expect(config.sessionlog.sync).toBe("off");
    });

    it("normalizes opentasks fields with defaults", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "test" }));
      const config = readConfig(configPath, noGlobal);
      expect(config.opentasks.enabled).toBe(false);
      expect(config.opentasks.autoStart).toBe(true);
    });

    it("reads opentasks.enabled from config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        opentasks: { enabled: true },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.opentasks.enabled).toBe(true);
    });

    it("reads opentasks.autoStart false from config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        opentasks: { enabled: true, autoStart: false },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.opentasks.autoStart).toBe(false);
    });

    it("returns defaults when file does not exist", () => {
      const config = readConfig(path.join(tmpDir, "nonexistent.json"), noGlobal);
      expect(config.template).toBe("");
      expect(config.map.enabled).toBe(false);
      expect(config.sessionlog.enabled).toBe(false);
    });

    it("returns defaults when file contains invalid JSON", () => {
      const configPath = writeFile(tmpDir, "config.json", "not json{{{");
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("");
      expect(config.map.enabled).toBe(false);
    });

    it("returns defaults when file is empty", () => {
      const configPath = writeFile(tmpDir, "config.json", "");
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("");
    });

    it("handles config with only template field", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "my-team" }));
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("my-team");
      expect(config.map.enabled).toBe(false);
    });

    it("preserves explicit scope", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { enabled: true, scope: "custom:scope" },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.scope).toBe("custom:scope");
    });

    it("implicitly enables MAP when map.server is configured", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://example.com:9090" },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.enabled).toBe(true);
    });

    it("does not implicitly enable MAP when no map config is present", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.enabled).toBe(false);
    });
  });

  describe("global config fallthrough", () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("uses global config values when project config is missing", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { server: "ws://global-server:9090", sidecar: "persistent" },
        sessionlog: { sync: "full" },
      }));
      const projectPath = path.join(tmpDir, "nonexistent.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.map.server).toBe("ws://global-server:9090");
      expect(config.map.sidecar).toBe("persistent");
      expect(config.sessionlog.sync).toBe("full");
    });

    it("project config overrides global config", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { server: "ws://global-server:9090", sidecar: "persistent" },
        sessionlog: { sync: "full" },
      }));
      const projectPath = writeFile(tmpDir, "project.json", JSON.stringify({
        map: { server: "ws://project-server:8080" },
        sessionlog: { sync: "lifecycle" },
      }));
      const config = readConfig(projectPath, globalPath);
      expect(config.map.server).toBe("ws://project-server:8080");
      expect(config.map.sidecar).toBe("persistent"); // falls through from global
      expect(config.sessionlog.sync).toBe("lifecycle");
    });

    it("project template overrides global template", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        template: "global-template",
      }));
      const projectPath = writeFile(tmpDir, "project.json", JSON.stringify({
        template: "project-template",
      }));
      const config = readConfig(projectPath, globalPath);
      expect(config.template).toBe("project-template");
    });

    it("global template is used when project has no template", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        template: "global-template",
      }));
      const projectPath = writeFile(tmpDir, "project.json", JSON.stringify({}));
      const config = readConfig(projectPath, globalPath);
      expect(config.template).toBe("global-template");
    });

    it("global map.enabled enables MAP when project has no map config", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { enabled: true, server: "ws://global-server:9090" },
      }));
      const projectPath = path.join(tmpDir, "nonexistent.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://global-server:9090");
    });

    it("global map.server implicitly enables MAP when project has no config", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { server: "ws://global-server:9090" },
      }));
      const projectPath = path.join(tmpDir, "nonexistent.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.map.enabled).toBe(true);
    });

    it("global sessionlog.enabled is used when project has no sessionlog config", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        sessionlog: { enabled: true, sync: "metrics" },
      }));
      const projectPath = path.join(tmpDir, "nonexistent.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.sessionlog.enabled).toBe(true);
      expect(config.sessionlog.sync).toBe("metrics");
    });

    it("falls back to defaults when both configs are missing", () => {
      const globalPath = path.join(tmpDir, "nonexistent-global.json");
      const projectPath = path.join(tmpDir, "nonexistent-project.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.template).toBe("");
      expect(config.map.enabled).toBe(false);
      expect(config.map.server).toBe(DEFAULTS.mapServer);
      expect(config.sessionlog.enabled).toBe(false);
      expect(config.sessionlog.sync).toBe(DEFAULTS.sessionlogSync);
    });

    it("per-field fallthrough: project scope + global server", () => {
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { server: "ws://global-server:9090", systemId: "global-system" },
      }));
      const projectPath = writeFile(tmpDir, "project.json", JSON.stringify({
        map: { scope: "my-project" },
      }));
      const config = readConfig(projectPath, globalPath);
      expect(config.map.scope).toBe("my-project");
      expect(config.map.server).toBe("ws://global-server:9090");
      expect(config.map.systemId).toBe("global-system");
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
    let noGlobal;
    const savedEnv = {};

    beforeEach(() => {
      tmpDir = makeTmpDir();
      noGlobal = path.join(tmpDir, "no-global.json");
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
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("env-template");
    });

    it("SWARM_MAP_ENABLED overrides config file", () => {
      process.env.SWARM_MAP_ENABLED = "true";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { enabled: false },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.enabled).toBe(true);
    });

    it("SWARM_MAP_ENABLED handles truthy variants (1, yes)", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({}));

      process.env.SWARM_MAP_ENABLED = "1";
      expect(readConfig(configPath, noGlobal).map.enabled).toBe(true);

      process.env.SWARM_MAP_ENABLED = "yes";
      expect(readConfig(configPath, noGlobal).map.enabled).toBe(true);

      process.env.SWARM_MAP_ENABLED = "YES";
      expect(readConfig(configPath, noGlobal).map.enabled).toBe(true);
    });

    it("SWARM_MAP_ENABLED=false overrides true in config", () => {
      process.env.SWARM_MAP_ENABLED = "false";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { enabled: true },
      }));
      expect(readConfig(configPath, noGlobal).map.enabled).toBe(false);
    });

    it("SWARM_MAP_ENABLED=false disables even when server is configured", () => {
      process.env.SWARM_MAP_ENABLED = "false";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://example.com:9090" },
      }));
      expect(readConfig(configPath, noGlobal).map.enabled).toBe(false);
    });

    it("SWARM_MAP_SERVER implicitly enables MAP", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({}));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://env-server:9090");
    });

    it("SWARM_MAP_SERVER overrides config file", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { server: "ws://file-server:8080" },
      }));
      expect(readConfig(configPath, noGlobal).map.server).toBe("ws://env-server:9090");
    });

    it("SWARM_MAP_SCOPE overrides config file", () => {
      process.env.SWARM_MAP_SCOPE = "custom:env-scope";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { scope: "custom:file-scope" },
      }));
      expect(readConfig(configPath, noGlobal).map.scope).toBe("custom:env-scope");
    });

    it("SWARM_MAP_SYSTEM_ID overrides config file", () => {
      process.env.SWARM_MAP_SYSTEM_ID = "env-system";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { systemId: "file-system" },
      }));
      expect(readConfig(configPath, noGlobal).map.systemId).toBe("env-system");
    });

    it("SWARM_MAP_SIDECAR overrides config file", () => {
      process.env.SWARM_MAP_SIDECAR = "persistent";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        map: { sidecar: "session" },
      }));
      expect(readConfig(configPath, noGlobal).map.sidecar).toBe("persistent");
    });

    it("SWARM_SESSIONLOG_ENABLED overrides config file", () => {
      process.env.SWARM_SESSIONLOG_ENABLED = "true";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        sessionlog: { enabled: false },
      }));
      expect(readConfig(configPath, noGlobal).sessionlog.enabled).toBe(true);
    });

    it("SWARM_SESSIONLOG_SYNC overrides config file", () => {
      process.env.SWARM_SESSIONLOG_SYNC = "full";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        sessionlog: { sync: "off" },
      }));
      expect(readConfig(configPath, noGlobal).sessionlog.sync).toBe("full");
    });

    it("SWARM_OPENTASKS_ENABLED overrides config file", () => {
      process.env.SWARM_OPENTASKS_ENABLED = "true";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        opentasks: { enabled: false },
      }));
      expect(readConfig(configPath, noGlobal).opentasks.enabled).toBe(true);
    });

    it("SWARM_OPENTASKS_AUTOSTART overrides default", () => {
      process.env.SWARM_OPENTASKS_AUTOSTART = "false";
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({}));
      expect(readConfig(configPath, noGlobal).opentasks.autoStart).toBe(false);
    });

    it("env vars override defaults when no config file exists", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      process.env.SWARM_MAP_SYSTEM_ID = "env-system";
      const config = readConfig(path.join(tmpDir, "nonexistent.json"), noGlobal);
      expect(config.map.enabled).toBe(true);
      expect(config.map.server).toBe("ws://env-server:9090");
      expect(config.map.systemId).toBe("env-system");
    });

    it("unset env vars fall through to config file values", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "file-template",
        map: { server: "ws://file-server:8080" },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.template).toBe("file-template");
      expect(config.map.server).toBe("ws://file-server:8080");
    });

    it("env vars override global config values", () => {
      process.env.SWARM_MAP_SERVER = "ws://env-server:9090";
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { server: "ws://global-server:8080" },
      }));
      const projectPath = path.join(tmpDir, "nonexistent.json");
      const config = readConfig(projectPath, globalPath);
      expect(config.map.server).toBe("ws://env-server:9090");
    });

    it("env vars override both project and global config", () => {
      process.env.SWARM_MAP_SIDECAR = "persistent";
      const globalPath = writeFile(tmpDir, "global.json", JSON.stringify({
        map: { sidecar: "session" },
      }));
      const projectPath = writeFile(tmpDir, "project.json", JSON.stringify({
        map: { sidecar: "session" },
      }));
      const config = readConfig(projectPath, globalPath);
      expect(config.map.sidecar).toBe("persistent");
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

  describe("resolveMapServer", () => {
    it("returns default server when no config", () => {
      const url = resolveMapServer({ map: {} });
      expect(url).toBe("ws://localhost:8080/");
    });

    it("appends API key as query param", () => {
      const url = resolveMapServer({
        map: { server: "ws://hub:3000", auth: { token: "my-key", param: "token" } },
      });
      expect(url).toContain("token=my-key");
    });

    it("uses custom param name for API key", () => {
      const url = resolveMapServer({
        map: { server: "ws://hub:3000", auth: { token: "key123", param: "api_key" } },
      });
      expect(url).toContain("api_key=key123");
    });

    it("appends swarm_id from config for stable identity", () => {
      const url = resolveMapServer({
        map: { server: "ws://hub:3000", swarmId: "my-swarm-id", auth: {} },
      });
      expect(url).toContain("swarm_id=my-swarm-id");
    });

    it("uses sessionId as default swarm_id", () => {
      const url = resolveMapServer({ map: { server: "ws://hub:3000", auth: {} } }, "sess-abc");
      expect(url).toContain("swarm_id=sess-abc");
    });

    it("prefers config swarmId over sessionId", () => {
      const url = resolveMapServer(
        { map: { server: "ws://hub:3000", swarmId: "explicit-id", auth: {} } },
        "sess-abc"
      );
      expect(url).toContain("swarm_id=explicit-id");
      expect(url).not.toContain("sess-abc");
    });

    it("does not append swarm_id when credential is set (verified mode)", () => {
      const url = resolveMapServer({
        map: {
          server: "ws://hub:3000",
          swarmId: "my-id",
          auth: { token: "key", credential: "iam-token-blob" },
        },
      });
      expect(url).not.toContain("swarm_id");
      // API key is still appended for hub access
      expect(url).toContain("token=key");
    });

    it("does not double-add token if already in URL", () => {
      const url = resolveMapServer({
        map: { server: "ws://hub:3000?token=existing", auth: { token: "new-key", param: "token" } },
      });
      expect(url).toContain("token=existing");
      expect(url).not.toContain("new-key");
    });
  });

  describe("readConfig — auth fields", () => {
    let tmpDir;
    let noGlobal;
    beforeEach(() => {
      tmpDir = makeTmpDir();
      noGlobal = path.join(tmpDir, "no-global.json");
    });
    afterEach(() => { cleanupTmpDir(tmpDir); });

    it("reads swarmId from config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { swarmId: "my-stable-id" },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.swarmId).toBe("my-stable-id");
    });

    it("reads auth.credential from config file", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({
        template: "test",
        map: { auth: { credential: "some-token-blob" } },
      }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.auth.credential).toBe("some-token-blob");
    });

    it("reads AGENT_TOKEN env var as credential", () => {
      const prev = process.env.AGENT_TOKEN;
      try {
        process.env.AGENT_TOKEN = "env-iam-token";
        const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "test" }));
        const config = readConfig(configPath, noGlobal);
        expect(config.map.auth.credential).toBe("env-iam-token");
      } finally {
        if (prev !== undefined) process.env.AGENT_TOKEN = prev;
        else delete process.env.AGENT_TOKEN;
      }
    });

    it("defaults swarmId and credential to empty string", () => {
      const configPath = writeFile(tmpDir, "config.json", JSON.stringify({ template: "test" }));
      const config = readConfig(configPath, noGlobal);
      expect(config.map.swarmId).toBe("");
      expect(config.map.auth.credential).toBe("");
    });
  });
});
