/**
 * Unit tests for memory file watcher (fs.watch implementation)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from "fs";
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

  // ── Null/skip cases ─────────────────────────────────────────────

  it("returns null for non-existent directory", () => {
    const result = startMemoryWatcher("/nonexistent/path", () => {});
    expect(result).toBeNull();
  });

  it("returns null for empty/undefined dir", () => {
    expect(startMemoryWatcher("", () => {})).toBeNull();
    expect(startMemoryWatcher(undefined, () => {})).toBeNull();
  });

  // ── Watcher lifecycle ───────────────────────────────────────────

  it("returns a watcher handle with close method", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    watcher = startMemoryWatcher(tmpDir, () => {});
    expect(watcher).not.toBeNull();
    expect(typeof watcher.close).toBe("function");
  });

  it("close() can be called multiple times without error", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));

    watcher = startMemoryWatcher(tmpDir, () => {});
    expect(watcher).not.toBeNull();
    watcher.close();
    watcher.close(); // should not throw
    watcher = null;
  });

  // ── File detection ──────────────────────────────────────────────

  it("detects new .md file and calls onSync", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    // Wait for watcher to initialize
    await new Promise((r) => setTimeout(r, 300));

    // Write a new .md file
    writeFileSync(join(tmpDir, "memory", "test-note.md"), "# Test Note\nContent here.");

    // Wait for debounce (2s) + buffer
    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).toHaveBeenCalled();
    const call = onSync.mock.calls[0][0];
    expect(call.path).toContain("test-note.md");
    // fs.watch reports 'rename' for new files, 'change' for modifications
    expect(["rename", "change"]).toContain(call.type);
  }, 10_000);

  it("detects changes to existing .md file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    // Create file before starting watcher
    const filePath = join(tmpDir, "memory", "existing.md");
    writeFileSync(filePath, "# Original");

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Modify the file
    writeFileSync(filePath, "# Updated content");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).toHaveBeenCalled();
    const call = onSync.mock.calls[0][0];
    expect(call.path).toContain("existing.md");
  }, 10_000);

  // ── Ignore patterns ─────────────────────────────────────────────

  it("ignores non-.md files", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Write non-.md files
    writeFileSync(join(tmpDir, "data.json"), "{}");
    writeFileSync(join(tmpDir, "config.yaml"), "key: value");
    writeFileSync(join(tmpDir, "README.txt"), "readme");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).not.toHaveBeenCalled();
  }, 10_000);

  it("ignores files in .minimem directory", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, ".minimem"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Write to .minimem (should be ignored even if .md)
    writeFileSync(join(tmpDir, ".minimem", "index.md"), "ignored");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).not.toHaveBeenCalled();
  }, 10_000);

  it("ignores files in .cache directory", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, ".cache"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    writeFileSync(join(tmpDir, ".cache", "embeddings.md"), "cached");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).not.toHaveBeenCalled();
  }, 10_000);

  // ── Debounce ────────────────────────────────────────────────────

  it("debounces rapid changes into a single callback", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, "memory"), { recursive: true });

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Write multiple files rapidly
    writeFileSync(join(tmpDir, "memory", "note1.md"), "# Note 1");
    writeFileSync(join(tmpDir, "memory", "note2.md"), "# Note 2");
    writeFileSync(join(tmpDir, "memory", "note3.md"), "# Note 3");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 3000));

    // Should only fire once (debounced)
    expect(onSync).toHaveBeenCalledTimes(1);
  }, 10_000);

  // ── Minimem directory structure ─────────────────────────────────

  it("watches the real minimem layout: memory/*.md + MEMORY.md", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));

    // Recreate minimem structure
    mkdirSync(join(tmpDir, "memory"), { recursive: true });
    mkdirSync(join(tmpDir, ".minimem"), { recursive: true });

    // Pre-existing files (like a real minimem store)
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Memory Index");
    writeFileSync(join(tmpDir, "memory", "existing-note.md"), "# Existing");
    writeFileSync(join(tmpDir, ".minimem", "config.json"), "{}");
    writeFileSync(join(tmpDir, ".minimem", "index.db"), "binary");

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Agent writes a new memory file (should trigger)
    writeFileSync(join(tmpDir, "memory", "knowledge-dns.md"), "# DNS Knowledge\nContent");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).toHaveBeenCalled();
    expect(onSync.mock.calls[0][0].path).toContain("knowledge-dns.md");
  }, 10_000);

  it("does not fire for .minimem/index.db updates in real layout", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-watch-"));
    mkdirSync(join(tmpDir, ".minimem"), { recursive: true });
    writeFileSync(join(tmpDir, ".minimem", "index.db"), "v1");

    const onSync = vi.fn();
    watcher = startMemoryWatcher(tmpDir, onSync);

    await new Promise((r) => setTimeout(r, 300));

    // Simulate index rebuild
    writeFileSync(join(tmpDir, ".minimem", "index.db"), "v2");

    await new Promise((r) => setTimeout(r, 3000));

    expect(onSync).not.toHaveBeenCalled();
  }, 10_000);
});
