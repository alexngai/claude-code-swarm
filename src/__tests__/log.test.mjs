import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// Create a shared temp dir for mock paths
const mockBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));

// Mock paths.mjs to use temp directories
vi.mock("../paths.mjs", () => {
  return {
    LOG_PATH: path.join(mockBaseDir, "swarm.log"),
    LOGS_DIR: path.join(mockBaseDir, "logs"),
  };
});

// Import after mock
const { createLogger, init, _reset } = await import("../log.mjs");
const { LOG_PATH, LOGS_DIR } = await import("../paths.mjs");

/** Find log files in a directory matching a session ID pattern */
function findSessionLog(dir, sessionId) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(
    (f) => f.endsWith(`_${sessionId}.log`)
  );
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

describe("log", () => {
  const savedEnv = {};

  beforeEach(() => {
    // Save and clear SWARM_LOG_* env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SWARM_LOG")) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    // Reset module state
    _reset();
    // Clean up any log files from prior tests
    try { fs.rmSync(path.dirname(LOG_PATH), { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    // Restore env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SWARM_LOG")) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
  });

  describe("createLogger", () => {
    it("returns an object with error, warn, info, debug methods", () => {
      const log = createLogger("test");
      expect(typeof log.error).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.info).toBe("function");
      expect(typeof log.debug).toBe("function");
    });

    it("scopes log entries to the module name", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("my-module");
      log.warn("test message");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("[my-module:warn]")
      );
      stderrSpy.mockRestore();
    });
  });

  describe("log levels", () => {
    let stderrSpy;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("defaults to warn level (error and warn emitted)", () => {
      const log = createLogger("test");
      log.error("err");
      log.warn("wrn");
      log.info("inf");
      log.debug("dbg");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("err"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("wrn"));
    });

    it("respects SWARM_LOG_LEVEL=error", () => {
      process.env.SWARM_LOG_LEVEL = "error";
      _reset();
      const log = createLogger("test");
      log.error("err");
      log.warn("wrn");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("err"));
    });

    it("respects SWARM_LOG_LEVEL=info", () => {
      process.env.SWARM_LOG_LEVEL = "info";
      _reset();
      const log = createLogger("test");
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(3);
    });

    it("respects SWARM_LOG_LEVEL=debug (all levels)", () => {
      process.env.SWARM_LOG_LEVEL = "debug";
      _reset();
      const log = createLogger("test");
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(4);
    });

    it("SWARM_LOG_LEVEL is case-insensitive", () => {
      process.env.SWARM_LOG_LEVEL = "DEBUG";
      _reset();
      const log = createLogger("test");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("init() can set level from config", () => {
      init({ level: "debug" });
      const log = createLogger("test");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("SWARM_LOG_LEVEL env var takes priority over init()", () => {
      process.env.SWARM_LOG_LEVEL = "error";
      _reset();
      init({ level: "debug" });
      const log = createLogger("test");
      log.warn("w");
      log.debug("d");
      expect(stderrSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("file output", () => {
    let stderrSpy;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("writes JSON Lines to the default log file", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log = createLogger("test");
      log.warn("hello");
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe("warn");
      expect(entry.mod).toBe("test");
      expect(entry.msg).toBe("hello");
      expect(entry.ts).toBeDefined();
    });

    it("includes data under a data key (no field collision)", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log = createLogger("test");
      log.warn("msg", { level: "overwrite", ts: "fake", extra: 42 });
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe("warn");
      expect(entry.mod).toBe("test");
      expect(entry.ts).not.toBe("fake");
      expect(entry.data.level).toBe("overwrite");
      expect(entry.data.ts).toBe("fake");
      expect(entry.data.extra).toBe(42);
    });

    it("omits data key when no data provided", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log = createLogger("test");
      log.warn("no data");
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.data).toBeUndefined();
    });

    it("omits data key when data is empty object", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log = createLogger("test");
      log.warn("empty data", {});
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.data).toBeUndefined();
    });

    it("appends multiple entries to the same file", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log = createLogger("test");
      log.warn("first");
      log.error("second");
      const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).msg).toBe("first");
      expect(JSON.parse(lines[1]).msg).toBe("second");
    });

    it("SWARM_LOG_FILE overrides default path", () => {
      const customDir = makeTmpDir("log-custom-");
      const customPath = path.join(customDir, "custom.log");
      process.env.SWARM_LOG_FILE = customPath;
      _reset();
      const log = createLogger("test");
      log.warn("custom");
      expect(fs.existsSync(customPath)).toBe(true);
      const entry = JSON.parse(fs.readFileSync(customPath, "utf-8").trim());
      expect(entry.msg).toBe("custom");
      cleanupTmpDir(customDir);
    });

    it("init({ file }) overrides default path", () => {
      const customDir = makeTmpDir("log-init-file-");
      const customPath = path.join(customDir, "init.log");
      init({ file: customPath });
      const log = createLogger("test");
      log.warn("init-file");
      expect(fs.existsSync(customPath)).toBe(true);
      cleanupTmpDir(customDir);
    });

    it("SWARM_LOG_FILE takes priority over init({ file })", () => {
      const envDir = makeTmpDir("log-env-file-");
      const initDir = makeTmpDir("log-init-file2-");
      const envPath = path.join(envDir, "env.log");
      const initPath = path.join(initDir, "init.log");
      process.env.SWARM_LOG_FILE = envPath;
      _reset();
      init({ file: initPath });
      const log = createLogger("test");
      log.warn("priority");
      expect(fs.existsSync(envPath)).toBe(true);
      expect(fs.existsSync(initPath)).toBe(false);
      cleanupTmpDir(envDir);
      cleanupTmpDir(initDir);
    });

    it("silently handles write failures (dir does not exist)", () => {
      process.env.SWARM_LOG_FILE = "/nonexistent/path/log.log";
      _reset();
      const log = createLogger("test");
      expect(() => log.warn("no crash")).not.toThrow();
    });
  });

  describe("stderr output", () => {
    it("writes human-readable format to stderr by default", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("bootstrap");
      log.warn("something happened");
      expect(spy).toHaveBeenCalledWith("[bootstrap:warn] something happened\n");
      spy.mockRestore();
    });

    it("includes stringified data in stderr", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("test");
      log.warn("msg", { key: "value" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('{"key":"value"}')
      );
      spy.mockRestore();
    });

    it("SWARM_LOG_STDERR=false disables stderr", () => {
      process.env.SWARM_LOG_STDERR = "false";
      _reset();
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("test");
      log.warn("should not appear");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("init({ stderr: false }) disables stderr", () => {
      init({ stderr: false });
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("test");
      log.warn("should not appear");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("per-session log files", () => {
    let stderrSpy;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("init({ sessionId }) writes to <LOGS_DIR>/<timestamp>_<sessionId>.log", () => {
      init({ sessionId: "sess-abc123" });
      const log = createLogger("test");
      log.warn("session log");

      const logFile = findSessionLog(LOGS_DIR, "sess-abc123");
      expect(logFile).not.toBeNull();
      const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
      expect(entry.msg).toBe("session log");
    });

    it("session log filename has timestamp prefix (YYYYMMDD-HHmmss)", () => {
      init({ sessionId: "sess-ts-check" });
      const log = createLogger("test");
      log.warn("check timestamp");

      const files = fs.readdirSync(LOGS_DIR).filter((f) => f.includes("sess-ts-check"));
      expect(files).toHaveLength(1);
      // Format: YYYYMMDD-HHmmss_sessionId.log
      expect(files[0]).toMatch(/^\d{8}-\d{6}_sess-ts-check\.log$/);
    });

    it("creates the logs directory if it does not exist", () => {
      expect(fs.existsSync(LOGS_DIR)).toBe(false);
      init({ sessionId: "sess-create-dir" });
      const log = createLogger("test");
      log.warn("creates dir");
      expect(fs.existsSync(LOGS_DIR)).toBe(true);
    });

    it("different sessions write to different files", () => {
      init({ sessionId: "sess-1" });
      const log1 = createLogger("test");
      log1.warn("from session 1");

      _reset();
      init({ sessionId: "sess-2" });
      const log2 = createLogger("test");
      log2.warn("from session 2");

      const file1 = findSessionLog(LOGS_DIR, "sess-1");
      const file2 = findSessionLog(LOGS_DIR, "sess-2");
      expect(file1).not.toBeNull();
      expect(file2).not.toBeNull();
      expect(file1).not.toBe(file2);
      expect(JSON.parse(fs.readFileSync(file1, "utf-8").trim()).msg).toBe("from session 1");
      expect(JSON.parse(fs.readFileSync(file2, "utf-8").trim()).msg).toBe("from session 2");
    });

    it("SWARM_LOG_FILE takes priority over sessionId", () => {
      const customDir = makeTmpDir("log-priority-");
      const customPath = path.join(customDir, "override.log");
      process.env.SWARM_LOG_FILE = customPath;
      _reset();
      init({ sessionId: "sess-ignored" });
      const log = createLogger("test");
      log.warn("goes to env file");

      expect(fs.existsSync(customPath)).toBe(true);
      expect(findSessionLog(LOGS_DIR, "sess-ignored")).toBeNull();
      cleanupTmpDir(customDir);
    });

    it("init({ file }) takes priority over sessionId", () => {
      const customDir = makeTmpDir("log-file-prio-");
      const customPath = path.join(customDir, "explicit.log");
      init({ file: customPath, sessionId: "sess-ignored" });
      const log = createLogger("test");
      log.warn("goes to explicit file");

      expect(fs.existsSync(customPath)).toBe(true);
      expect(findSessionLog(LOGS_DIR, "sess-ignored")).toBeNull();
      cleanupTmpDir(customDir);
    });
  });

  describe("configurable log directory", () => {
    let stderrSpy;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("init({ dir }) changes where session logs are written", () => {
      const customDir = makeTmpDir("log-dir-");
      init({ dir: customDir, sessionId: "sess-custom-dir" });
      const log = createLogger("test");
      log.warn("custom dir");

      const logFile = findSessionLog(customDir, "sess-custom-dir");
      expect(logFile).not.toBeNull();
      cleanupTmpDir(customDir);
    });

    it("SWARM_LOG_DIR env var overrides init({ dir })", () => {
      const envDir = makeTmpDir("log-env-dir-");
      const initDir = makeTmpDir("log-init-dir-");
      process.env.SWARM_LOG_DIR = envDir;
      _reset();
      init({ dir: initDir, sessionId: "sess-env-dir" });
      const log = createLogger("test");
      log.warn("env dir wins");

      expect(findSessionLog(envDir, "sess-env-dir")).not.toBeNull();
      expect(findSessionLog(initDir, "sess-env-dir")).toBeNull();
      cleanupTmpDir(envDir);
      cleanupTmpDir(initDir);
    });

    it("dir without sessionId does not change the log file", () => {
      const customDir = makeTmpDir("log-dir-no-session-");
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      init({ dir: customDir });
      const log = createLogger("test");
      log.warn("no session");

      expect(fs.existsSync(LOG_PATH)).toBe(true);
      const files = fs.existsSync(customDir)
        ? fs.readdirSync(customDir).filter((f) => f.endsWith(".log"))
        : [];
      expect(files).toHaveLength(0);
      cleanupTmpDir(customDir);
    });
  });

  describe("_reset", () => {
    it("allows re-initialization with different settings", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
      const log = createLogger("test");

      log.info("should not appear");
      expect(spy).not.toHaveBeenCalled();

      _reset();
      init({ level: "info" });
      log.info("should appear");
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });

  describe("edge cases", () => {
    let stderrSpy;
    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("handles invalid SWARM_LOG_LEVEL gracefully (falls back to warn)", () => {
      process.env.SWARM_LOG_LEVEL = "invalid";
      _reset();
      const log = createLogger("test");
      log.warn("w");
      log.info("i");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("init() with no arguments does not crash", () => {
      expect(() => init()).not.toThrow();
    });

    it("init() with empty object does not crash", () => {
      expect(() => init({})).not.toThrow();
    });

    it("multiple loggers share the same level and file", () => {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const log1 = createLogger("mod-a");
      const log2 = createLogger("mod-b");
      log1.warn("from a");
      log2.warn("from b");
      const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).mod).toBe("mod-a");
      expect(JSON.parse(lines[1]).mod).toBe("mod-b");
    });

    it("never throws even when everything fails", () => {
      process.env.SWARM_LOG_FILE = "/nonexistent/dir/file.log";
      _reset();
      const log = createLogger("test");
      expect(() => {
        log.error("e");
        log.warn("w");
        log.info("i");
        log.debug("d");
      }).not.toThrow();
    });
  });
});
