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
    SOCKET_PATH: path.join(tmpDir, "sidecar.sock"),
    PID_PATH: path.join(tmpDir, "sidecar.pid"),
    MAP_DIR: path.join(tmpDir, "map"),
    SIDECAR_LOG_PATH: path.join(tmpDir, "sidecar.log"),
    pluginDir: vi.fn(() => tmpDir),
  };
});

// Mock child_process for installDeps
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const { bootstrap } = await import("../bootstrap.mjs");
const { readConfig } = await import("../config.mjs");
const { killSidecar, startSidecar } = await import("../sidecar-client.mjs");
const { checkSessionlogStatus, syncSessionlog } = await import("../sessionlog.mjs");
const { pluginDir } = await import("../paths.mjs");

describe("bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config with no MAP, no sessionlog
    readConfig.mockReturnValue(makeConfig());
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
});
