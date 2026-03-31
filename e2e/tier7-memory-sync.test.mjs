/**
 * Tier 7: minimem → MAP sync integration test
 *
 * Tests the full bridge flow:
 *   Agent uses minimem MCP tool (write) → PostToolUse hook fires
 *   → map-hook.mjs builds bridge command → sidecar calls x-openhive/memory.sync
 *   → Mock MAP server receives the sync notification
 *
 * Groups:
 *   1. Hook configuration verification (no agent, no LLM)
 *   2. Bridge command builder (no agent, no LLM)
 *   3. Live agent writes memory → MAP event received (LIVE_AGENT_TEST=1)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace, waitFor } from "./helpers/cleanup.mjs";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

// Check if dependencies are available (try require for CJS-compatible packages)
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let minimemAvailable = false;
try {
  require("minimem");
  minimemAvailable = true;
} catch { /* minimem not installed */ }

let mapSdkAvailable = false;
try {
  require("@multi-agent-protocol/sdk");
  mapSdkAvailable = true;
} catch { /* MAP SDK not installed */ }

// Check if Claude CLI is available
let cliAvailable = false;
try {
  const { CLI_AVAILABLE } = await import("./helpers/cli.mjs");
  cliAvailable = CLI_AVAILABLE;
} catch { /* CLI not available */ }

// ── Group 1: Hook configuration ─────────────────────────────────────────────

describe("tier7: minimem sync hook configuration", { timeout: 30_000 }, () => {
  it("hooks.json has a PostToolUse entry for minimem", () => {
    const hooksPath = join(import.meta.dirname, "..", "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const postToolUse = hooks.hooks.PostToolUse || [];

    const minimemHook = postToolUse.find((h) => h.matcher === "minimem");
    expect(minimemHook).toBeDefined();
    expect(minimemHook.hooks[0].command).toContain("minimem-mcp-used");
  });

  it("minimem hook checks both minimem.enabled and map.enabled", () => {
    const hooksPath = join(import.meta.dirname, "..", "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const postToolUse = hooks.hooks.PostToolUse || [];

    const minimemHook = postToolUse.find((h) => h.matcher === "minimem");
    const cmd = minimemHook.hooks[0].command;

    expect(cmd).toContain("minimem");
    expect(cmd).toContain("map");
  });

  it("hooks.json minimem hook is gated behind config check", () => {
    const hooksPath = join(import.meta.dirname, "..", "hooks", "hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const postToolUse = hooks.hooks.PostToolUse || [];

    const minimemHook = postToolUse.find((h) => h.matcher === "minimem");
    const cmd = minimemHook.hooks[0].command;

    // Should have the config check prefix (node -e "..." && node map-hook.mjs)
    expect(cmd).toContain('node -e');
    expect(cmd).toContain('process.exit');
    expect(cmd).toContain('map-hook.mjs');
  });
});

// ── Group 2: Bridge command builder ─────────────────────────────────────────

describe("tier7: minimem bridge command builder", { timeout: 30_000 }, () => {
  it("builds command for write operations", async () => {
    const { buildMinimemBridgeCommand } = await import("../src/map-events.mjs");

    const cmd = buildMinimemBridgeCommand({
      tool_name: "minimem__memory_append",
      tool_input: { text: "Test memory entry" },
      session_id: "test-session",
    });

    expect(cmd).not.toBeNull();
    expect(cmd.action).toBe("bridge-memory-sync");
    expect(cmd.agentId).toBe("test-session");
  });

  it("skips read-only operations", async () => {
    const { buildMinimemBridgeCommand } = await import("../src/map-events.mjs");

    const cmd = buildMinimemBridgeCommand({
      tool_name: "minimem__memory_search",
      tool_input: { query: "test" },
    });

    expect(cmd).toBeNull();
  });

  it("map-hook.mjs switch statement includes minimem-mcp-used", () => {
    const hookScript = readFileSync(
      join(import.meta.dirname, "..", "scripts", "map-hook.mjs"),
      "utf-8"
    );
    expect(hookScript).toContain('"minimem-mcp-used"');
    expect(hookScript).toContain("handleMinimemMcpUsed");
  });

  it("sidecar-server.mjs handles bridge-memory-sync command", () => {
    const sidecarScript = readFileSync(
      join(import.meta.dirname, "..", "src", "sidecar-server.mjs"),
      "utf-8"
    );
    expect(sidecarScript).toContain('"bridge-memory-sync"');
    expect(sidecarScript).toContain("x-openhive/memory.sync");
  });
});

// ── Group 3: Live agent test ────────────────────────────────────────────────

describe.skipIf(!process.env.LIVE_AGENT_TEST || !minimemAvailable || !cliAvailable || !mapSdkAvailable)(
  "tier7: live agent minimem → MAP sync",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;
    let messages;
    let runResult;

    beforeAll(async () => {
      const { MockMapServer } = await import("./helpers/map-mock-server.mjs");
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        config: {
          minimem: { enabled: true, provider: "none" },
          map: {
            enabled: true,
            server: `ws://localhost:${mockServer.port}`,
          },
        },
        gitInit: true,
      });

      // Initialize minimem in the workspace so the MCP server can start.
      // Must run `minimem sync` to create index.db — without it the MCP server
      // starts but may report tools inconsistently.
      const minimemDir = join(workspace.dir, ".swarm", "minimem");
      mkdirSync(join(minimemDir, "memory"), { recursive: true });
      writeFileSync(join(minimemDir, "MEMORY.md"), "# Test Memory\n");
      writeFileSync(
        join(minimemDir, "config.json"),
        JSON.stringify({ embedding: { provider: "none" } })
      );
      writeFileSync(join(minimemDir, ".gitignore"), "index.db\n");

      // Initialize the search index — critical for MCP server readiness.
      // Use require() to avoid ESM resolution issues with node:sqlite in vitest.
      try {
        const { Minimem } = require("minimem");
        const mem = await Minimem.create({ memoryDir: minimemDir, embedding: { provider: "none" } });
        await mem.sync();
        await mem.close();
      } catch (err) {
        console.warn("[tier7] minimem init warning:", err.message?.slice(0, 200));
      }

      const { runClaude } = await import("./helpers/cli.mjs");
      runResult = await runClaude(
        'Use the minimem MCP tools: First search for "test" using memory_search. Then write a memory file at .swarm/minimem/memory/e2e-test.md containing "### 2026-03-31 12:00\n<!-- type: decision -->\nChose PostgreSQL for the main database." using the Write tool. Report what you did.',
        {
          cwd: workspace.dir,
          model: "haiku",
          maxTurns: 6,
          maxBudgetUsd: 0.5,
          timeout: 120_000,
          label: "memory-sync-e2e",
        }
      );
      messages = runResult.messages;
    }, 300_000);

    afterAll(async () => {
      if (workspace) {
        try { cleanupWorkspace(workspace.dir); } catch { /* best effort */ }
      }
      if (mockServer) {
        try { await mockServer.stop(); } catch { /* best effort */ }
      }
    });

    it("agent completed without error", () => {
      expect(runResult.exitCode).toBe(0);
    });

    it("agent used minimem MCP tools", () => {
      const { extractToolCalls } = require("./helpers/assertions.mjs");
      const allCalls = extractToolCalls(messages);
      const memCalls = allCalls.filter((c) =>
        c.name?.includes("minimem") || c.name?.includes("memory_search")
      );
      expect(memCalls.length).toBeGreaterThan(0);
    });

    it("agent wrote a memory file", () => {
      const { extractToolCalls } = require("./helpers/assertions.mjs");
      const allCalls = extractToolCalls(messages);
      // Agent may use Write tool to create memory file, or minimem append/upsert
      const writeCalls = allCalls.filter(
        (c) => c.name === "Write" || c.name?.includes("append") || c.name?.includes("upsert")
      );
      expect(writeCalls.length).toBeGreaterThan(0);
    });

    it("memory file was written to disk", () => {
      const minimemDir = join(workspace.dir, ".swarm", "minimem");
      const memoryDir = join(minimemDir, "memory");
      if (!existsSync(memoryDir)) return; // skip if dir not created
      const mdFiles = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
      expect(mdFiles.length).toBeGreaterThan(0);
    });

    it("sidecar file watcher sent MAP sync notification", async () => {
      // The sidecar's memory file watcher detects .md file writes and sends
      // bridge-memory-sync → callExtension("x-openhive/memory.sync").
      // This covers both Write tool and minimem MCP tool writes.
      //
      // The watcher has a 2s debounce, so we wait up to 10s for the event.
      const received = await waitFor(() => {
        const extCalls = mockServer.getByMethod("x-openhive/memory.sync");
        if (extCalls.length > 0) return true;
        const broadcasts = mockServer.getMessages("memory.sync");
        if (broadcasts.length > 0) return true;
        // Check all received messages for any memory-related content
        const all = mockServer.receivedMessages || [];
        return all.some(
          (m) =>
            JSON.stringify(m).includes("memory") &&
            JSON.stringify(m).includes("sync")
        );
      }, 10_000);

      expect(received).toBe(true);
    });
  }
);
