/**
 * Unit tests for memory file watcher
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startMemoryWatcher } from "../memory-watcher.mjs";

describe("startMemoryWatcher", () => {
  let tmpDir;
  let watcher;

  afterEach(() => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch {}
      tmpDir = null;
    }
  });

  it("returns null for non-existent directory", () => {
    const result = startMemoryWatcher("/nonexistent/path", () => {});
    expect(result).toBeNull();
  });

  it("returns null for empty/undefined dir", () => {
    expect(startMemoryWatcher("", () => {})).toBeNull();
    expect(startMemoryWatcher(undefined, () => {})).toBeNull();
  });

  it("returns a watcher handle with close method", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    watcher = startMemoryWatcher(tmpDir, () => {});
    expect(watcher).not.toBeNull();
    expect(typeof watcher.close).toBe("function");
  });

  it("detects new .md file and calls onSync", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    // Wait for watcher to be ready
    await new Promise((r) => setTimeout(r, 500));

    // Write a new .md file
    writeFileSync(join(tmpDir, "memory", "test-note.md"), "# Test Note\nContent here.");

    // Wait for debounce (2s) + buffer
    await new Promise((r) => setTimeout(r, 3500));

    expect(onSync).toHaveBeenCalled();
    const call = onSync.mock.calls[0][0];
    expect(call.type).toBe("add");
    expect(call.path).toContain("test-note.md");
  }, 10_000);

  it("ignores non-.md files", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 500));

    // Write non-.md files
    writeFileSync(join(tmpDir, "index.db"), "binary data");
    writeFileSync(join(tmpDir, "config.json"), "{}");

    await new Promise((r) => setTimeout(r, 3500));

    expect(onSync).not.toHaveBeenCalled();
  }, 10_000);

  it("debounces rapid changes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 500));

    // Write multiple files rapidly
    writeFileSync(join(tmpDir, "memory", "note1.md"), "# Note 1");
    writeFileSync(join(tmpDir, "memory", "note2.md"), "# Note 2");
    writeFileSync(join(tmpDir, "memory", "note3.md"), "# Note 3");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 3500));

    // Should only fire once (debounced)
    expect(onSync).toHaveBeenCalledTimes(1);
  }, 10_000);
});
