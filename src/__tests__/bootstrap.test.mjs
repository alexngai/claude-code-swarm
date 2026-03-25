import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { makeTmpDir, cleanupTmpDir, makeConfig } from "./helpers.mjs";

// Mock all src/ dependencies
vi.mock("../config.mjs", () => ({
  readConfig: vi.fn(() => makeConfig()),
  resolveScope: vi.fn(() => "swarm:test-team"),
  resolveTeamName: vi.fn(() => "test-team"),
}));

vi.mock("../sidecar-client.mjs", () => ({
  killSidecar: vi.fn(),
  startSidecar: vi.fn().mockResolvedValue(true),
  sendToInbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../map-events.mjs", () => ({
  sendCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../sessionlog.mjs", () => ({
  checkSessionlogStatus: vi.fn(() => "not installed"),
  ensureSessionlogEnabled: vi.fn().mockResolvedValue(false),
  hasStandaloneHooks: vi.fn().mockReturnValue(false),
  syncSessionlog: vi.fn().mockResolvedValue(undefined),
  annotateSwarmSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../paths.mjs", async () => {
  const tmpDir = (await import("fs")).mkdtempSync(
    (await import("path")).join((await import("os")).tmpdir(), "bootstrap-test-")
  );
  return {
    SWARM_DIR: path.join(tmpDir, ".swarm", "claude-swarm"),
    CONFIG_PATH: path.join(tmpDir, ".swarm", "claude-swarm", "config.json"),
    TMP_DIR: path.join(tmpDir, ".swarm", "claude-swarm", "tmp"),
    TEAMS_DIR: path.join(tmpDir, ".swarm", "claude-swarm", "tmp", "teams"),
    SOCKET_PATH: path.join(tmpDir, "sidecar.sock"),
    PID_PATH: path.join(tmpDir, "sidecar.pid"),
    MAP_DIR: path.join(tmpDir, "map"),
    SIDECAR_LOG_PATH: path.join(tmpDir, "sidecar.log"),
    LOG_PATH: path.join(tmpDir, "swarm.log"),
    LOGS_DIR: path.join(tmpDir, "logs"),
    OPENTASKS_DIR: path.join(tmpDir, "opentasks"),
    INBOX_SOCKET_PATH: path.join(tmpDir, "inbox.sock"),
    teamDir: vi.fn((name) => `${tmpDir}/.swarm/claude-swarm/tmp/teams/${name}`),
    ensureSwarmDir: vi.fn(),
    ensureMapDir: vi.fn(),
    ensureOpentasksDir: vi.fn(),
    ensureSessionDir: vi.fn(),
    listSessionDirs: vi.fn().mockReturnValue([]),
    sessionPaths: vi.fn((id) => ({
      inboxSocketPath: path.join(tmpDir, `sessions/${id}/inbox.sock`),
    })),
    pluginDir: vi.fn(() => tmpDir),
  };
});

// Mock child_process for installLocalDeps
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock swarmkit-resolver
const mockSwarmkit = {
  getInstalledVersion: vi.fn().mockResolvedValue("1.0.0"),
  installPackages: vi.fn().mockResolvedValue([]),
  addInstalledPackages: vi.fn(),
  isProjectInit: vi.fn().mockReturnValue(false),
  initProjectPackage: vi.fn().mockResolvedValue({ package: "openteams", success: true }),
};

vi.mock("../opentasks-client.mjs", () => ({
  findSocketPath: vi.fn(() => "/tmp/test-daemon.sock"),
  isDaemonAlive: vi.fn().mockResolvedValue(false),
  ensureDaemon: vi.fn().mockResolvedValue(true),
}));

vi.mock("../swarmkit-resolver.mjs", () => ({
  resolveSwarmkit: vi.fn().mockResolvedValue(mockSwarmkit),
  configureNodePath: vi.fn(),
}));

const { bootstrap, backgroundInit } = await import("../bootstrap.mjs");
const { readConfig } = await import("../config.mjs");
const { killSidecar, startSidecar } = await import("../sidecar-client.mjs");
const { sendCommand } = await import("../map-events.mjs");
const { checkSessionlogStatus, ensureSessionlogEnabled, hasStandaloneHooks, syncSessionlog, annotateSwarmSession } = await import("../sessionlog.mjs");
const { pluginDir, ensureOpentasksDir, ensureSessionDir, listSessionDirs } = await import("../paths.mjs");
const { findSocketPath, isDaemonAlive, ensureDaemon } = await import("../opentasks-client.mjs");
const { resolveSwarmkit, configureNodePath } = await import("../swarmkit-resolver.mjs");

describe("bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config with no MAP, no sessionlog
    readConfig.mockReturnValue(makeConfig());
    // Default: swarmkit available with all packages installed
    resolveSwarmkit.mockResolvedValue(mockSwarmkit);
    mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
    mockSwarmkit.installPackages.mockResolvedValue([]);
    mockSwarmkit.isProjectInit.mockReturnValue(false);
    mockSwarmkit.initProjectPackage.mockResolvedValue({ package: "openteams", success: true });
  });

  describe("fast path", () => {
    it("returns complete context object", async () => {
      const result = await bootstrap();
      expect(result).toHaveProperty("template");
      expect(result).toHaveProperty("mapEnabled");
      expect(result).toHaveProperty("mapStatus");
      expect(result).toHaveProperty("sessionlogEnabled");
      expect(result).toHaveProperty("sessionlogStatus");
      expect(result).toHaveProperty("sessionlogSync");
    });

    it("reads config", async () => {
      await bootstrap();
      expect(readConfig).toHaveBeenCalled();
    });

    it("configures NODE_PATH during bootstrap", async () => {
      await bootstrap();
      expect(configureNodePath).toHaveBeenCalled();
    });

    describe("MAP disabled", () => {
      it("returns mapStatus 'disabled'", async () => {
        const result = await bootstrap();
        expect(result.mapStatus).toBe("disabled");
      });

      it("does not start sidecar in fast path", async () => {
        await bootstrap();
        expect(killSidecar).not.toHaveBeenCalled();
        expect(startSidecar).not.toHaveBeenCalled();
      });
    });

    describe("MAP enabled, session sidecar", () => {
      beforeEach(() => {
        readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sidecar: "session" }));
      });

      it("returns 'starting' status immediately (sidecar starts in background)", async () => {
        const result = await bootstrap();
        expect(result.mapStatus).toContain("starting");
      });
    });

    describe("MAP enabled, persistent sidecar", () => {
      beforeEach(() => {
        readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sidecar: "persistent" }));
      });

      it("returns WARNING when socket does not exist", async () => {
        const result = await bootstrap();
        expect(result.mapStatus).toContain("WARNING");
      });
    });

    describe("sessionlog", () => {
      it("defers to standalone when standalone hooks are present", async () => {
        hasStandaloneHooks.mockReturnValue(true);
        readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
        const result = await bootstrap();
        expect(result.sessionlogStatus).toBe("active (standalone)");
        expect(ensureSessionlogEnabled).not.toHaveBeenCalled();
      });

      it("enables sessionlog when no standalone hooks", async () => {
        hasStandaloneHooks.mockReturnValue(false);
        ensureSessionlogEnabled.mockResolvedValue(true);
        readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
        const result = await bootstrap();
        expect(result.sessionlogStatus).toBe("active");
        expect(ensureSessionlogEnabled).toHaveBeenCalled();
      });

      it("reports status when enable fails", async () => {
        hasStandaloneHooks.mockReturnValue(false);
        ensureSessionlogEnabled.mockResolvedValue(false);
        readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
        const result = await bootstrap();
        expect(result.sessionlogStatus).toBe("installed but not enabled");
      });

      it("returns 'checking' when hasStandaloneHooks throws", async () => {
        hasStandaloneHooks.mockImplementation(() => { throw new Error("unexpected"); });
        readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
        const result = await bootstrap();
        expect(result.sessionlogStatus).toBe("checking");
      });

      it("does not check standalone when disabled", async () => {
        readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: false }));
        await bootstrap();
        expect(hasStandaloneHooks).not.toHaveBeenCalled();
        expect(ensureSessionlogEnabled).not.toHaveBeenCalled();
      });
    });

    describe("opentasks", () => {
      it("returns opentasksStatus 'disabled' when not enabled", async () => {
        readConfig.mockReturnValue(makeConfig({ opentasksEnabled: false }));
        const result = await bootstrap();
        expect(result.opentasksStatus).toBe("disabled");
      });

      it("returns opentasksStatus 'enabled' when enabled (actual probe is in background)", async () => {
        readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true }));
        const result = await bootstrap();
        expect(result.opentasksStatus).toBe("enabled");
      });
    });

    describe("per-session", () => {
      it("returns sessionId in result", async () => {
        const result = await bootstrap(undefined, "session-ret");
        expect(result.sessionId).toBe("session-ret");
      });

      it("returns undefined sessionId when not provided", async () => {
        const result = await bootstrap();
        expect(result.sessionId).toBeUndefined();
      });
    });
  });

  describe("backgroundInit", () => {
    it("calls ensureGlobalPackages (resolveSwarmkit + version checks)", async () => {
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(resolveSwarmkit).toHaveBeenCalled();
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("openteams");
    });

    it("calls initSwarmProject (project directory init)", async () => {
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.initProjectPackage).toHaveBeenCalledWith(
        "openteams",
        expect.objectContaining({ usePrefix: true })
      );
    });

    it("calls initProjectPackage for claude-code-swarm when not initialized", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.initProjectPackage).toHaveBeenCalledWith(
        "claude-code-swarm",
        expect.objectContaining({
          usePrefix: true,
          packages: expect.arrayContaining(["claude-code-swarm"]),
        })
      );
    });

    it("skips initProjectPackage when already initialized", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(true);
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.initProjectPackage).not.toHaveBeenCalled();
    });

    it("does not install when all packages are present", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.installPackages).not.toHaveBeenCalled();
    });

    it("installs missing packages", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
      ]);
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.installPackages).toHaveBeenCalledWith(
        expect.arrayContaining(["openteams"])
      );
    });

    it("records installed packages in swarmkit", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
      ]);
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.addInstalledPackages).toHaveBeenCalledWith(["openteams"]);
    });

    it("handles swarmkit unavailable gracefully", async () => {
      resolveSwarmkit.mockResolvedValue(null);
      const config = makeConfig();
      // Should not throw
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.getInstalledVersion).not.toHaveBeenCalled();
    });

    it("checks MAP SDK only when MAP is enabled", async () => {
      const config = makeConfig({ mapEnabled: true });
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("multi-agent-protocol");
    });

    it("does not check MAP SDK when MAP is disabled", async () => {
      const config = makeConfig({ mapEnabled: false });
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("multi-agent-protocol");
    });

    it("checks sessionlog only when sessionlog is enabled", async () => {
      const config = makeConfig({ sessionlogEnabled: true });
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("sessionlog");
    });

    it("does not check sessionlog when sessionlog is disabled", async () => {
      const config = makeConfig({ sessionlogEnabled: false });
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("sessionlog");
    });

    it("installs all missing packages when MAP and sessionlog are enabled", async () => {
      const config = makeConfig({ mapEnabled: true, sessionlogEnabled: true });
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
        { package: "multi-agent-protocol", success: true, version: "0.1.1" },
        { package: "sessionlog", success: true, version: "0.1.0" },
      ]);
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.installPackages).toHaveBeenCalledWith(
        expect.arrayContaining(["openteams", "multi-agent-protocol", "sessionlog"])
      );
    });

    it("continues when install fails", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockRejectedValue(new Error("npm failed"));
      const config = makeConfig();
      // Should not throw
      await backgroundInit(config, "swarm:test", pluginDir(), null);
    });

    it("initializes sessionlog project when enabled", async () => {
      const config = makeConfig({ sessionlogEnabled: true });
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(mockSwarmkit.initProjectPackage).toHaveBeenCalledWith(
        "sessionlog",
        expect.objectContaining({ usePrefix: true })
      );
    });

    it("does not initialize sessionlog when disabled", async () => {
      const config = makeConfig({ sessionlogEnabled: false });
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      const calls = mockSwarmkit.initProjectPackage.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("sessionlog");
    });

    it("continues when project init fails", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      mockSwarmkit.initProjectPackage.mockRejectedValue(new Error("init failed"));
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
    });

    it("falls back to ensureSwarmDir when swarmkit lacks init functions", async () => {
      const { ensureSwarmDir } = await import("../paths.mjs");
      resolveSwarmkit.mockResolvedValue({
        getInstalledVersion: vi.fn().mockResolvedValue("1.0.0"),
        installPackages: vi.fn().mockResolvedValue([]),
        addInstalledPackages: vi.fn(),
        // No isProjectInit or initProjectPackage
      });
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(ensureSwarmDir).toHaveBeenCalled();
    });

    it("falls back to ensureSwarmDir when swarmkit is unavailable", async () => {
      const { ensureSwarmDir } = await import("../paths.mjs");
      resolveSwarmkit.mockResolvedValue(null);
      const config = makeConfig();
      await backgroundInit(config, "swarm:test", pluginDir(), null);
      expect(ensureSwarmDir).toHaveBeenCalled();
    });

    describe("MAP sidecar", () => {
      it("kills existing sidecar and starts new one (session mode)", async () => {
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(killSidecar).toHaveBeenCalled();
        expect(startSidecar).toHaveBeenCalled();
      });

      it("calls listSessionDirs during cleanup (session mode)", async () => {
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(listSessionDirs).toHaveBeenCalled();
      });

      it("calls ensureSessionDir when sessionId provided", async () => {
        const config = makeConfig({ mapEnabled: true });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-abc");
        expect(ensureSessionDir).toHaveBeenCalledWith("session-abc");
      });

      it("passes sessionId to killSidecar and startSidecar", async () => {
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-xyz");
        expect(killSidecar).toHaveBeenCalledWith("session-xyz");
        expect(startSidecar).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          "session-xyz"
        );
      });

      it("registers main agent via spawn command after sidecar starts", async () => {
        startSidecar.mockResolvedValue(true);
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-main");
        // Allow fire-and-forget promise to settle
        await new Promise((r) => setTimeout(r, 50));
        expect(sendCommand).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "spawn",
            agent: expect.objectContaining({
              agentId: "session-main",
              name: "test-team-main",
              role: "orchestrator",
              metadata: expect.objectContaining({ isMain: true, sessionId: "session-main" }),
            }),
          }),
          "session-main"
        );
      });

      it("uses sessionId as agentId for main agent", async () => {
        startSidecar.mockResolvedValue(true);
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), "abc-123-def");
        await new Promise((r) => setTimeout(r, 50));
        const spawnCall = sendCommand.mock.calls.find(
          (c) => c[1]?.action === "spawn"
        );
        expect(spawnCall).toBeDefined();
        expect(spawnCall[1].agent.agentId).toBe("abc-123-def");
      });

      it("does not register main agent when sidecar fails to start", async () => {
        startSidecar.mockResolvedValue(false);
        const config = makeConfig({ mapEnabled: true, sidecar: "session" });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-fail");
        await new Promise((r) => setTimeout(r, 50));
        expect(sendCommand).not.toHaveBeenCalled();
      });
    });

    describe("sessionlog sync", () => {
      it("triggers sync when MAP enabled and sync != off", async () => {
        const config = makeConfig({ mapEnabled: true, sessionlogSync: "full" });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(syncSessionlog).toHaveBeenCalled();
      });

      it("does not trigger sync when sync is off", async () => {
        const config = makeConfig({ mapEnabled: true, sessionlogSync: "off" });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(syncSessionlog).not.toHaveBeenCalled();
      });

      it("passes sessionId to syncSessionlog", async () => {
        const config = makeConfig({ mapEnabled: true, sessionlogSync: "full" });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-sync");
        expect(syncSessionlog).toHaveBeenCalledWith(expect.anything(), "session-sync");
      });
    });

    describe("sessionlog annotation", () => {
      it("annotates session when sessionlog is enabled", async () => {
        const config = makeConfig({ sessionlogEnabled: true });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-abc");
        expect(annotateSwarmSession).toHaveBeenCalledWith(expect.anything(), "session-abc");
      });

      it("does not annotate when sessionlog is disabled", async () => {
        const config = makeConfig({ sessionlogEnabled: false });
        await backgroundInit(config, "swarm:test", pluginDir(), "session-abc");
        expect(annotateSwarmSession).not.toHaveBeenCalled();
      });
    });

    describe("opentasks", () => {
      it("calls ensureOpentasksDir when enabled", async () => {
        const config = makeConfig({ opentasksEnabled: true });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(ensureOpentasksDir).toHaveBeenCalled();
      });

      it("calls ensureDaemon when enabled with autoStart", async () => {
        const config = makeConfig({ opentasksEnabled: true, opentasksAutoStart: true });
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(ensureDaemon).toHaveBeenCalled();
      });

      it("checks opentasks package via swarmkit when enabled", async () => {
        const config = makeConfig({ opentasksEnabled: true });
        mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("opentasks");
      });

      it("does not check opentasks package when disabled", async () => {
        const config = makeConfig({ opentasksEnabled: false });
        mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
        await backgroundInit(config, "swarm:test", pluginDir(), null);
        const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
        expect(calls).not.toContain("opentasks");
      });
    });
  });
});
