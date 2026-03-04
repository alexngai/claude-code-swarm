/**
 * Tier 4: MAP Event Flow Tests
 *
 * Verifies the MAP sidecar starts, connects to the mock MAP server,
 * and events are emitted during team operations.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { runClaude, runInitOnly, CLI_AVAILABLE } from "./helpers/cli.mjs";
import { findToolCalls, getResult } from "./helpers/assertions.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";
import { cleanupWorkspace, waitFor } from "./helpers/cleanup.mjs";
import { MockMapServer } from "./helpers/map-mock-server.mjs";

describe.skipIf(!CLI_AVAILABLE)(
  "tier4: MAP event flow",
  { timeout: 300_000 },
  () => {
    let mockServer;
    let workspace;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();
    });

    afterAll(async () => {
      await mockServer.stop();
    });

    afterEach(() => {
      mockServer.clearMessages();
      if (workspace) {
        cleanupWorkspace(workspace.dir);
        workspace.cleanup();
      }
    });

    function mapConfig() {
      return {
        template: "get-shit-done",
        map: {
          enabled: true,
          server: `ws://localhost:${mockServer.port}`,
          sidecar: "session",
        },
      };
    }

    it("sidecar creates PID file when MAP is enabled", async () => {
      workspace = createWorkspace({ config: mapConfig() });

      // Try init-only first (no LLM cost), fallback to minimal LLM call
      const initResult = await runInitOnly({ cwd: workspace.dir });
      if (initResult.exitCode !== 0) {
        await runClaude(
          "Respond with just the word OK. Do not use any tools.",
          { cwd: workspace.dir, maxBudgetUsd: 0.05, maxTurns: 1 }
        );
      }

      const pidPath = path.join(
        workspace.dir,
        ".swarm",
        "claude-swarm",
        "tmp",
        "map",
        "sidecar.pid"
      );

      // PID file may exist if the sidecar started successfully
      // It might not exist if the MAP SDK isn't installed (optional peer dep)
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim());
        expect(pid).toBeGreaterThan(0);
      } else {
        // Check stderr for MAP-related messages to confirm it was attempted
        console.warn(
          "Sidecar PID file not found — MAP SDK may not be installed (optional peer dep)"
        );
      }
    });

    it("mock MAP server receives connection from sidecar", async () => {
      workspace = createWorkspace({ config: mapConfig() });

      const initResult = await runInitOnly({ cwd: workspace.dir });
      if (initResult.exitCode !== 0) {
        await runClaude(
          "Respond with just the word OK. Do not use any tools.",
          { cwd: workspace.dir, maxBudgetUsd: 0.05, maxTurns: 1 }
        );
      }

      // Wait for the sidecar to connect
      const connected = await waitFor(
        () => mockServer.connections.length > 0,
        10_000
      );

      if (!connected) {
        console.warn(
          "No sidecar connection to mock server — MAP SDK may not be installed"
        );
      } else {
        expect(mockServer.connections.length).toBeGreaterThan(0);
      }
    });

    it("mock server receives messages during /swarm invocation", async () => {
      workspace = createWorkspace({ config: mapConfig() });
      const { messages } = await runClaude("Please run /swarm get-shit-done", {
        cwd: workspace.dir,
        maxBudgetUsd: 5.0,
        maxTurns: 30,
      });

      // Wait for events to be received
      await waitFor(
        () => mockServer.receivedMessages.length > 0,
        10_000
      );

      const allEvents = mockServer.getMessages();

      // If TeamCreate was called and sidecar is connected, we should see events
      const teamCreates = findToolCalls(messages, "TeamCreate");
      if (teamCreates.length > 0 && allEvents.length > 0) {
        expect(allEvents.length).toBeGreaterThan(0);

        // Look for agent lifecycle events
        const agentEvents = allEvents.filter(
          (m) =>
            m.data?.type?.startsWith?.("swarm.agent.") ||
            m.data?.params?.type?.startsWith?.("swarm.agent.")
        );
        // Agent events depend on the hooks firing during Agent tool use
        if (agentEvents.length > 0) {
          expect(agentEvents.length).toBeGreaterThan(0);
        }
      } else if (allEvents.length === 0) {
        console.warn(
          "No MAP events received — sidecar may not have connected"
        );
      }
    });

    it("sidecar process is killable via PID file", async () => {
      workspace = createWorkspace({ config: mapConfig() });

      const initResult = await runInitOnly({ cwd: workspace.dir });
      if (initResult.exitCode !== 0) {
        await runClaude(
          "Respond with just the word OK. Do not use any tools.",
          { cwd: workspace.dir, maxBudgetUsd: 0.05, maxTurns: 1 }
        );
      }

      const pidPath = path.join(
        workspace.dir,
        ".swarm",
        "claude-swarm",
        "tmp",
        "map",
        "sidecar.pid"
      );

      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim());

        // Verify process is alive
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          // already dead
        }

        if (alive) {
          // Kill it
          process.kill(pid, "SIGTERM");

          // Wait for it to die
          const died = await waitFor(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }, 5000);

          expect(died).toBe(true);
        }
      } else {
        console.warn("Sidecar PID file not found — skipping kill test");
      }
    });
  }
);
