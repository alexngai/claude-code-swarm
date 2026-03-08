import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { makeTmpDir, cleanupTmpDir, makeConfig } from "./helpers.mjs";

// Mock all src/ dependencies
vi.mock("../config.mjs", () => ({
  readConfig: vi.fn(() => makeConfig()),
  resolveScope: vi.fn(() => "swarm:test-team"),
}));

vi.mock("../sidecar-client.mjs", () => ({
  killSidecar: vi.fn(),
  startSidecar: vi.fn().mockResolvedValue(true),
}));

vi.mock("../sessionlog.mjs", () => ({
  checkSessionlogStatus: vi.fn(() => "not installed"),
  syncSessionlog: vi.fn().mockResolvedValue(undefined),
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
    OPENTASKS_DIR: path.join(tmpDir, "opentasks"),
    teamDir: vi.fn((name) => `${tmpDir}/.swarm/claude-swarm/tmp/teams/${name}`),
    ensureSwarmDir: vi.fn(),
    ensureMapDir: vi.fn(),
    ensureOpentasksDir: vi.fn(),
    ensureSessionDir: vi.fn(),
    listSessionDirs: vi.fn().mockReturnValue([]),
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

const { bootstrap } = await import("../bootstrap.mjs");
const { readConfig } = await import("../config.mjs");
const { killSidecar, startSidecar } = await import("../sidecar-client.mjs");
const { checkSessionlogStatus, syncSessionlog } = await import("../sessionlog.mjs");
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

  describe("MAP disabled", () => {
    it("returns mapStatus 'disabled'", async () => {
      const result = await bootstrap();
      expect(result.mapStatus).toBe("disabled");
    });

    it("does not start sidecar", async () => {
      await bootstrap();
      expect(killSidecar).not.toHaveBeenCalled();
      expect(startSidecar).not.toHaveBeenCalled();
    });
  });

  describe("MAP enabled, session sidecar", () => {
    beforeEach(() => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sidecar: "session" }));
    });

    it("kills existing sidecar before starting new one", async () => {
      await bootstrap();
      expect(killSidecar).toHaveBeenCalled();
    });

    it("starts sidecar", async () => {
      await bootstrap();
      expect(startSidecar).toHaveBeenCalled();
    });

    it("returns 'connected' when sidecar starts successfully", async () => {
      startSidecar.mockResolvedValue(true);
      const result = await bootstrap();
      expect(result.mapStatus).toContain("connected");
    });

    it("returns 'starting' when sidecar does not confirm", async () => {
      startSidecar.mockResolvedValue(false);
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

    it("does not kill or start sidecar", async () => {
      await bootstrap();
      expect(killSidecar).not.toHaveBeenCalled();
      expect(startSidecar).not.toHaveBeenCalled();
    });
  });

  describe("sessionlog", () => {
    it("checks sessionlog status when enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
      await bootstrap();
      expect(checkSessionlogStatus).toHaveBeenCalled();
    });

    it("does not check sessionlog when disabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: false }));
      await bootstrap();
      expect(checkSessionlogStatus).not.toHaveBeenCalled();
    });

    it("triggers initial sync when MAP enabled and sync != off", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sessionlogSync: "full" }));
      await bootstrap();
      expect(syncSessionlog).toHaveBeenCalled();
    });

    it("does not trigger sync when sync is off", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sessionlogSync: "off" }));
      await bootstrap();
      expect(syncSessionlog).not.toHaveBeenCalled();
    });
  });

  describe("swarmkit integration", () => {
    it("configures NODE_PATH during bootstrap", async () => {
      await bootstrap();
      expect(configureNodePath).toHaveBeenCalled();
    });

    it("resolves swarmkit and checks packages", async () => {
      await bootstrap();
      expect(resolveSwarmkit).toHaveBeenCalled();
      // openteams is always checked
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("openteams");
    });

    it("does not install when all packages are present", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      expect(mockSwarmkit.installPackages).not.toHaveBeenCalled();
    });

    it("installs missing packages", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
      ]);
      await bootstrap();
      expect(mockSwarmkit.installPackages).toHaveBeenCalledWith(
        expect.arrayContaining(["openteams"])
      );
    });

    it("records installed packages in swarmkit", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
      ]);
      await bootstrap();
      expect(mockSwarmkit.addInstalledPackages).toHaveBeenCalledWith(["openteams"]);
    });

    it("handles swarmkit unavailable gracefully", async () => {
      resolveSwarmkit.mockResolvedValue(null);
      const result = await bootstrap();
      // Should still return valid context, not throw
      expect(result).toHaveProperty("template");
      expect(mockSwarmkit.getInstalledVersion).not.toHaveBeenCalled();
    });

    it("checks MAP SDK only when MAP is enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("multi-agent-protocol");
    });

    it("does not check MAP SDK when MAP is disabled", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: false }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("multi-agent-protocol");
    });

    it("checks sessionlog only when sessionlog is enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("sessionlog");
    });

    it("does not check sessionlog when sessionlog is disabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: false }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("sessionlog");
    });

    it("installs all missing packages when MAP and sessionlog are enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sessionlogEnabled: true }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockResolvedValue([
        { package: "openteams", success: true, version: "0.2.1" },
        { package: "multi-agent-protocol", success: true, version: "0.1.1" },
        { package: "sessionlog", success: true, version: "0.1.0" },
      ]);
      await bootstrap();
      expect(mockSwarmkit.installPackages).toHaveBeenCalledWith(
        expect.arrayContaining(["openteams", "multi-agent-protocol", "sessionlog"])
      );
    });

    it("continues bootstrap even when install fails", async () => {
      mockSwarmkit.getInstalledVersion.mockResolvedValue(null);
      mockSwarmkit.installPackages.mockRejectedValue(new Error("npm failed"));
      const result = await bootstrap();
      // Should still return valid context
      expect(result).toHaveProperty("template");
    });
  });

  describe("swarmkit project init", () => {
    it("calls initProjectPackage for openteams when not initialized", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await bootstrap();
      expect(mockSwarmkit.initProjectPackage).toHaveBeenCalledWith(
        "openteams",
        expect.objectContaining({ usePrefix: true })
      );
    });

    it("calls initProjectPackage for claude-code-swarm when not initialized", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await bootstrap();
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
      await bootstrap();
      expect(mockSwarmkit.initProjectPackage).not.toHaveBeenCalled();
    });

    it("initializes sessionlog when sessionlog is enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: true }));
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await bootstrap();
      expect(mockSwarmkit.initProjectPackage).toHaveBeenCalledWith(
        "sessionlog",
        expect.objectContaining({ usePrefix: true })
      );
    });

    it("does not initialize sessionlog when disabled", async () => {
      readConfig.mockReturnValue(makeConfig({ sessionlogEnabled: false }));
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      await bootstrap();
      const calls = mockSwarmkit.initProjectPackage.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("sessionlog");
    });

    it("continues bootstrap when project init fails", async () => {
      mockSwarmkit.isProjectInit.mockReturnValue(false);
      mockSwarmkit.initProjectPackage.mockRejectedValue(new Error("init failed"));
      const result = await bootstrap();
      expect(result).toHaveProperty("template");
    });

    it("falls back to ensureSwarmDir when swarmkit lacks init functions", async () => {
      const { ensureSwarmDir } = await import("../paths.mjs");
      resolveSwarmkit.mockResolvedValue({
        getInstalledVersion: vi.fn().mockResolvedValue("1.0.0"),
        installPackages: vi.fn().mockResolvedValue([]),
        addInstalledPackages: vi.fn(),
        // No isProjectInit or initProjectPackage
      });
      await bootstrap();
      expect(ensureSwarmDir).toHaveBeenCalled();
    });

    it("falls back to ensureSwarmDir when swarmkit is unavailable", async () => {
      const { ensureSwarmDir } = await import("../paths.mjs");
      resolveSwarmkit.mockResolvedValue(null);
      await bootstrap();
      expect(ensureSwarmDir).toHaveBeenCalled();
    });
  });

  describe("opentasks", () => {
    it("returns opentasksStatus 'disabled' when not enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: false }));
      const result = await bootstrap();
      expect(result.opentasksStatus).toBe("disabled");
    });

    it("calls ensureOpentasksDir when enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true }));
      await bootstrap();
      expect(ensureOpentasksDir).toHaveBeenCalled();
    });

    it("calls ensureDaemon when enabled with autoStart", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true, opentasksAutoStart: true }));
      await bootstrap();
      expect(ensureDaemon).toHaveBeenCalled();
    });

    it("returns 'connected' when ensureDaemon succeeds", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true }));
      ensureDaemon.mockResolvedValue(true);
      const result = await bootstrap();
      expect(result.opentasksStatus).toBe("connected");
    });

    it("returns 'starting' when ensureDaemon fails", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true }));
      ensureDaemon.mockResolvedValue(false);
      const result = await bootstrap();
      expect(result.opentasksStatus).toBe("starting");
    });

    it("calls isDaemonAlive when autoStart is false", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true, opentasksAutoStart: false }));
      isDaemonAlive.mockResolvedValue(true);
      await bootstrap();
      expect(isDaemonAlive).toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    });

    it("returns 'connected' when daemon is already alive (autoStart false)", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true, opentasksAutoStart: false }));
      isDaemonAlive.mockResolvedValue(true);
      const result = await bootstrap();
      expect(result.opentasksStatus).toBe("connected");
    });

    it("returns 'not running' when daemon is not alive (autoStart false)", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true, opentasksAutoStart: false }));
      isDaemonAlive.mockResolvedValue(false);
      const result = await bootstrap();
      expect(result.opentasksStatus).toContain("not running");
    });

    it("checks opentasks package via swarmkit when enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: true }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      expect(mockSwarmkit.getInstalledVersion).toHaveBeenCalledWith("opentasks");
    });

    it("does not check opentasks package when disabled", async () => {
      readConfig.mockReturnValue(makeConfig({ opentasksEnabled: false }));
      mockSwarmkit.getInstalledVersion.mockResolvedValue("1.0.0");
      await bootstrap();
      const calls = mockSwarmkit.getInstalledVersion.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain("opentasks");
    });
  });

  describe("per-session sidecar", () => {
    it("calls ensureSessionDir when sessionId provided and MAP enabled", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true }));
      await bootstrap(undefined, "session-abc");
      expect(ensureSessionDir).toHaveBeenCalledWith("session-abc");
    });

    it("passes sessionId to killSidecar and startSidecar", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sidecar: "session" }));
      await bootstrap(undefined, "session-xyz");
      expect(killSidecar).toHaveBeenCalledWith("session-xyz");
      expect(startSidecar).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "session-xyz"
      );
    });

    it("passes sessionId to syncSessionlog", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sessionlogSync: "full" }));
      await bootstrap(undefined, "session-sync");
      expect(syncSessionlog).toHaveBeenCalledWith(expect.anything(), "session-sync");
    });

    it("returns sessionId in result", async () => {
      const result = await bootstrap(undefined, "session-ret");
      expect(result.sessionId).toBe("session-ret");
    });

    it("returns null sessionId when not provided", async () => {
      const result = await bootstrap();
      expect(result.sessionId).toBeUndefined();
    });

    it("calls listSessionDirs during cleanup (session sidecar mode)", async () => {
      readConfig.mockReturnValue(makeConfig({ mapEnabled: true, sidecar: "session" }));
      await bootstrap(undefined, "session-cleanup");
      expect(listSessionDirs).toHaveBeenCalled();
    });
  });
});
