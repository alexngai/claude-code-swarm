/**
 * Tier 7: Hook & Event Builder Integration Tests
 *
 * Tests the MAP event pipeline without LLM calls:
 *   1. Pure event builder functions (buildSubagentSpawnCommand, etc.)
 *   2. mapNativeTaskStatus status mapping
 *   3. Sidecar IPC round-trip (bridge commands → mock MAP server)
 *   4. Hook script integration (scripts/map-hook.mjs with crafted stdin)
 *   5. Full pipeline (skill-tree → agent generation)
 *
 * No LLM calls — exercises pure computation, IPC, and subprocess hooks.
 *
 * Run:
 *   npx vitest run --config e2e/vitest.config.e2e.mjs e2e/tier7-hooks.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createWorkspace } from "./helpers/workspace.mjs";
import { MockMapServer } from "./helpers/map-mock-server.mjs";
import { startTestSidecar, sendCommand } from "./helpers/sidecar.mjs";
import { waitFor } from "./helpers/cleanup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");
const HOOK_SCRIPT = path.join(PLUGIN_DIR, "scripts", "map-hook.mjs");
const SHORT_TMPDIR = "/tmp";

// Import pure builder functions from map-events
const {
  buildSubagentSpawnCommand,
  buildSubagentDoneCommand,
  buildStateCommand,
  buildTaskSyncPayload,
  buildOpentasksBridgeCommands,
  mapNativeTaskStatus,
} = await import("../src/map-events.mjs");

const { generateAgentMd } = await import("../src/agent-generator.mjs");

// Check if skill-tree is available
let skillTreeAvailable = false;
try {
  const st = await import("skill-tree");
  skillTreeAvailable = !!st.createSkillBank;
} catch {
  // Not installed
}

/**
 * Run a hook script with stdin data and return stdout + stderr.
 */
function runHook(action, stdinData, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK_SCRIPT, action], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.stdin.write(JSON.stringify(stdinData));
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr });
    }, 15000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: MAP Event Builders (pure functions)
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: buildSubagentSpawnCommand",
  { timeout: 15_000 },
  () => {
    it("builds spawn command with all fields", () => {
      const cmd = buildSubagentSpawnCommand(
        { agent_id: "sub-1", agent_type: "researcher", session_id: "sess-1" },
        "gsd"
      );

      expect(cmd.action).toBe("spawn");
      expect(cmd.agent.agentId).toBe("sub-1");
      expect(cmd.agent.name).toBe("researcher");
      expect(cmd.agent.role).toBe("subagent");
      expect(cmd.agent.scopes).toEqual(["swarm:gsd"]);
      expect(cmd.agent.metadata.agentType).toBe("researcher");
      expect(cmd.agent.metadata.sessionId).toBe("sess-1");
      expect(cmd.agent.metadata.isTeamRole).toBe(false);
    });

    it("uses fallback agentId when agent_id is missing", () => {
      const cmd = buildSubagentSpawnCommand(
        { agent_type: "coder" },
        "test"
      );

      expect(cmd.agent.agentId).toMatch(/^test-subagent-/);
      expect(cmd.agent.name).toBe("coder");
    });

    it("defaults empty agent_type to 'subagent'", () => {
      const cmd = buildSubagentSpawnCommand({}, "t");

      expect(cmd.agent.name).toBe("subagent");
      expect(cmd.agent.metadata.agentType).toBe("");
    });
  }
);

describe(
  "tier7: buildSubagentDoneCommand",
  { timeout: 15_000 },
  () => {
    it("builds done command with agentId and reason", () => {
      const cmd = buildSubagentDoneCommand(
        { agent_id: "sub-1", last_assistant_message: "All done." },
        "gsd"
      );

      expect(cmd.action).toBe("done");
      expect(cmd.agentId).toBe("sub-1");
      expect(cmd.reason).toBe("All done.");
    });

    it("truncates reason to 500 chars", () => {
      const cmd = buildSubagentDoneCommand(
        { agent_id: "x", last_assistant_message: "A".repeat(600) },
        "gsd"
      );

      expect(cmd.reason.length).toBe(500);
    });

    it("defaults reason to 'completed' when no message", () => {
      const cmd = buildSubagentDoneCommand({ agent_id: "x" }, "gsd");
      expect(cmd.reason).toBe("completed");
    });

    it("defaults agentId to empty string when missing", () => {
      const cmd = buildSubagentDoneCommand({}, "gsd");
      expect(cmd.agentId).toBe("");
    });
  }
);

describe(
  "tier7: buildStateCommand",
  { timeout: 15_000 },
  () => {
    it("builds state command with agentId and metadata", () => {
      const cmd = buildStateCommand("agent-1", "busy", {
        lastStopReason: "tool_use",
      });

      expect(cmd).toEqual({
        action: "state",
        state: "busy",
        agentId: "agent-1",
        metadata: { lastStopReason: "tool_use" },
      });
    });

    it("omits agentId when null (sidecar self-update)", () => {
      const cmd = buildStateCommand(null, "idle");

      expect(cmd.action).toBe("state");
      expect(cmd.state).toBe("idle");
      expect(cmd).not.toHaveProperty("agentId");
      expect(cmd).not.toHaveProperty("metadata");
    });

    it("omits metadata when not provided", () => {
      const cmd = buildStateCommand("a", "idle");

      expect(cmd.action).toBe("state");
      expect(cmd.agentId).toBe("a");
      expect(cmd).not.toHaveProperty("metadata");
    });
  }
);

describe(
  "tier7: buildTaskSyncPayload",
  { timeout: 15_000 },
  () => {
    it("builds task.sync payload with tool_input fields", () => {
      const payload = buildTaskSyncPayload(
        { tool_input: { taskId: "t-1", status: "in_progress", subject: "Fix bug" } },
        "gsd"
      );

      expect(payload).toEqual({
        type: "task.sync",
        uri: "claude://gsd/t-1",
        status: "in_progress",
        subject: "Fix bug",
        source: "claude-code",
      });
    });

    it("maps 'pending' status to 'open'", () => {
      const payload = buildTaskSyncPayload(
        { tool_input: { status: "pending" } },
        "t"
      );

      expect(payload.status).toBe("open");
    });

    it("falls back to task_id and task_subject from hookData", () => {
      const payload = buildTaskSyncPayload(
        { task_id: "fallback-1", task_subject: "Subject" },
        "t"
      );

      expect(payload.uri).toBe("claude://t/fallback-1");
      expect(payload.subject).toBe("Subject");
    });

    it("defaults status to 'open' when missing", () => {
      const payload = buildTaskSyncPayload({ tool_input: {} }, "t");
      expect(payload.status).toBe("open");
    });
  }
);

describe(
  "tier7: buildOpentasksBridgeCommands",
  { timeout: 15_000 },
  () => {
    it("create_task → bridge-task-created + bridge-task-assigned", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__create_task",
        tool_input: { title: "New", assignee: "exec" },
        tool_output: JSON.stringify({
          content: [{ text: JSON.stringify({ id: "ot-1", title: "New", status: "open", assignee: "exec" }) }],
        }),
      });

      expect(cmds).toHaveLength(2);
      expect(cmds[0].action).toBe("bridge-task-created");
      expect(cmds[0].task.id).toBe("ot-1");
      expect(cmds[0].task.title).toBe("New");
      expect(cmds[0].task.assignee).toBe("exec");
      expect(cmds[1].action).toBe("bridge-task-assigned");
      expect(cmds[1].taskId).toBe("ot-1");
      expect(cmds[1].assignee).toBe("exec");
    });

    it("create_task without assignee → only bridge-task-created", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__create_task",
        tool_input: { title: "Solo" },
        tool_output: JSON.stringify({
          content: [{ text: JSON.stringify({ id: "ot-2", title: "Solo", status: "open" }) }],
        }),
      });

      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("bridge-task-created");
    });

    it("create_task with no id and no title → empty array", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__create_task",
        tool_input: {},
        tool_output: null,
      });

      expect(cmds).toEqual([]);
    });

    it("update_task → bridge-task-status", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__update_task",
        tool_input: { id: "ot-1", status: "in_progress" },
        tool_output: JSON.stringify({
          content: [{ text: JSON.stringify({ id: "ot-1", status: "in_progress" }) }],
        }),
      });

      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("bridge-task-status");
      expect(cmds[0].taskId).toBe("ot-1");
      expect(cmds[0].current).toBe("in_progress");
    });

    it("update_task without id → empty array", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__update_task",
        tool_input: {},
        tool_output: null,
      });

      expect(cmds).toEqual([]);
    });

    it("link → emit task.linked", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__link",
        tool_input: { fromId: "a", toId: "b", type: "blocks" },
      });

      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("emit");
      expect(cmds[0].event.type).toBe("task.linked");
      expect(cmds[0].event.from).toBe("a");
      expect(cmds[0].event.to).toBe("b");
      expect(cmds[0].event.linkType).toBe("blocks");
      expect(cmds[0].event.remove).toBe(false);
      expect(cmds[0].event.source).toBe("opentasks");
    });

    it("link without fromId or toId → empty array", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__link",
        tool_input: { fromId: "a" },
      });

      expect(cmds).toEqual([]);
    });

    it("annotate → emit task.sync", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__annotate",
        tool_input: { target: "native://t-1", feedback: { type: "review" } },
      });

      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBe("emit");
      expect(cmds[0].event.type).toBe("task.sync");
      expect(cmds[0].event.uri).toBe("native://t-1");
      expect(cmds[0].event.annotation).toBe("review");
      expect(cmds[0].event.source).toBe("opentasks");
    });

    it("annotate without target → empty array", () => {
      const cmds = buildOpentasksBridgeCommands({
        tool_name: "opentasks__annotate",
        tool_input: {},
      });

      expect(cmds).toEqual([]);
    });

    it("read-only tools → empty array", () => {
      for (const tool of ["opentasks__list_tasks", "opentasks__query", "opentasks__get_task", "opentasks__list_providers"]) {
        const cmds = buildOpentasksBridgeCommands({
          tool_name: tool,
          tool_input: {},
        });
        expect(cmds).toEqual([]);
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: mapNativeTaskStatus
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: mapNativeTaskStatus",
  { timeout: 15_000 },
  () => {
    it("maps 'pending' to 'open'", () => {
      expect(mapNativeTaskStatus("pending")).toBe("open");
    });

    it("maps 'in_progress' to 'in_progress'", () => {
      expect(mapNativeTaskStatus("in_progress")).toBe("in_progress");
    });

    it("maps 'completed' to 'completed'", () => {
      expect(mapNativeTaskStatus("completed")).toBe("completed");
    });

    it("passes unknown status through unchanged", () => {
      expect(mapNativeTaskStatus("blocked")).toBe("blocked");
    });

    it("returns 'open' for undefined", () => {
      expect(mapNativeTaskStatus(undefined)).toBe("open");
    });

    it("returns 'open' for empty string", () => {
      expect(mapNativeTaskStatus("")).toBe("open");
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Sidecar IPC Round-Trip (bridge commands → mock MAP server)
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: sidecar bridge commands",
  { timeout: 60_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();
    });

    afterAll(async () => {
      if (sidecar) {
        sidecar.cleanup();
        sidecar = null;
      }
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
      await mockServer.stop();
    });

    afterEach(() => {
      mockServer.clearMessages();
    });

    // Start sidecar once for all bridge tests
    it("starts sidecar and connects to mock MAP", async () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7h-bridge-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
        },
      });

      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
      });

      expect(sidecar.pid).toBeGreaterThan(0);

      // Verify MAP connection
      const connectMsgs = mockServer.getByMethod("map/connect");
      expect(connectMsgs.length).toBeGreaterThan(0);
    });

    it("bridge-task-created reaches MAP as task.created message", async () => {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "bridge-task-created",
        task: { id: "t-1", title: "Test Task", status: "open", assignee: "exec" },
        agentId: "exec",
      });
      expect(resp?.ok).toBe(true);

      // Wait for message to arrive on mock server
      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.created"
        );
      }, 3000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.created"
      );
      expect(msg.payload.task.id).toBe("t-1");
      expect(msg.payload.task.title).toBe("Test Task");
      expect(msg.payload._origin).toBe("exec");
    });

    it("bridge-task-status reaches MAP as task.status message", async () => {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "bridge-task-status",
        taskId: "t-1",
        previous: "open",
        current: "in_progress",
        agentId: "exec",
      });
      expect(resp?.ok).toBe(true);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.status"
        );
      }, 3000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.status"
      );
      expect(msg.payload.taskId).toBe("t-1");
      expect(msg.payload.previous).toBe("open");
      expect(msg.payload.current).toBe("in_progress");
    });

    it("bridge-task-status with 'completed' also emits task.completed", async () => {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "bridge-task-status",
        taskId: "t-2",
        previous: "in_progress",
        current: "completed",
        agentId: "exec",
      });
      expect(resp?.ok).toBe(true);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.completed"
        );
      }, 3000);
      expect(found).toBe(true);

      const completedMsg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.completed"
      );
      expect(completedMsg.payload.taskId).toBe("t-2");
    });

    it("bridge-task-assigned reaches MAP as task.assigned message", async () => {
      const resp = await sendCommand(sidecar.socketPath, {
        action: "bridge-task-assigned",
        taskId: "t-1",
        assignee: "worker-1",
        agentId: "worker-1",
      });
      expect(resp?.ok).toBe(true);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.assigned"
        );
      }, 3000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.assigned"
      );
      expect(msg.payload.taskId).toBe("t-1");
      expect(msg.payload.agentId).toBe("worker-1");
    });

    it("multiple bridge commands in sequence all arrive", async () => {
      const before = mockServer.sentMessages.length;

      await sendCommand(sidecar.socketPath, {
        action: "bridge-task-created",
        task: { id: "seq-1", title: "A", status: "open" },
        agentId: "opentasks",
      });
      await sendCommand(sidecar.socketPath, {
        action: "bridge-task-assigned",
        taskId: "seq-1",
        assignee: "w",
        agentId: "w",
      });
      await sendCommand(sidecar.socketPath, {
        action: "bridge-task-status",
        taskId: "seq-1",
        current: "in_progress",
        agentId: "w",
      });

      const found = await waitFor(() => {
        return mockServer.sentMessages.length >= before + 3;
      }, 5000);
      expect(found).toBe(true);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Hook Script Integration
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: hook script integration",
  { timeout: 60_000 },
  () => {
    let mockServer;
    let workspace;
    let sidecar;

    beforeAll(async () => {
      mockServer = new MockMapServer();
      await mockServer.start();

      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7h-hooks-",
        config: {
          template: "gsd",
          map: { enabled: true, server: `ws://localhost:${mockServer.port}` },
        },
      });

      sidecar = await startTestSidecar({
        workspaceDir: workspace.dir,
        mockServerPort: mockServer.port,
      });
    });

    afterAll(async () => {
      if (sidecar) {
        sidecar.cleanup();
        sidecar = null;
      }
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
      await mockServer.stop();
    });

    afterEach(() => {
      mockServer.clearMessages();
    });

    it("subagent-start hook sends spawn to MAP", async () => {
      const result = await runHook(
        "subagent-start",
        { agent_id: "sub-hook-1", agent_type: "researcher", session_id: "" },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.spawnedAgents.some(
          (a) => a.agentId === "sub-hook-1"
        );
      }, 5000);
      expect(found).toBe(true);

      const agent = mockServer.spawnedAgents.find(
        (a) => a.agentId === "sub-hook-1"
      );
      expect(agent.role).toBe("subagent");
    });

    it("subagent-stop hook sends done/unregister to MAP", async () => {
      // First spawn a subagent so it's registered
      await sendCommand(sidecar.socketPath, {
        action: "spawn",
        agent: {
          agentId: "sub-hook-2",
          name: "worker",
          role: "subagent",
          scopes: ["swarm:gsd"],
          metadata: {},
        },
      });

      await waitFor(() => {
        return mockServer.spawnedAgents.some(
          (a) => a.agentId === "sub-hook-2"
        );
      }, 3000);

      mockServer.clearMessages();

      const result = await runHook(
        "subagent-stop",
        { agent_id: "sub-hook-2", last_assistant_message: "Done with work.", session_id: "" },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.callExtensions.some(
          (c) => c.method === "map/agents/unregister" && c.params?.agentId === "sub-hook-2"
        );
      }, 5000);
      expect(found).toBe(true);
    });

    it("turn-completed hook sends state idle to MAP", async () => {
      const result = await runHook(
        "turn-completed",
        { stop_reason: "end_turn", session_id: "" },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.stateUpdates.length > 0;
      }, 5000);
      expect(found).toBe(true);
    });

    it("native-task-created hook sends bridge events to MAP", async () => {
      const result = await runHook(
        "native-task-created",
        {
          tool_input: { subject: "Fix bug", status: "pending", owner: "worker-1" },
          tool_output: { id: "nt-1" },
          session_id: "",
        },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.created"
        );
      }, 5000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.created"
      );
      expect(msg.payload.task.id).toBe("nt-1");
      expect(msg.payload.task.title).toBe("Fix bug");

      // Should also have task.assigned since owner was provided
      const assignedFound = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.assigned"
        );
      }, 3000);
      expect(assignedFound).toBe(true);
    });

    it("native-task-updated hook sends bridge-task-status to MAP", async () => {
      const result = await runHook(
        "native-task-updated",
        {
          tool_input: { taskId: "nt-1", status: "completed" },
          session_id: "",
        },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.status"
        );
      }, 5000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.status"
      );
      expect(msg.payload.taskId).toBe("nt-1");
      expect(msg.payload.current).toBe("completed");
    });

    it("opentasks-mcp-used hook sends bridge commands for create_task", async () => {
      const result = await runHook(
        "opentasks-mcp-used",
        {
          tool_name: "opentasks__create_task",
          tool_input: { title: "OT task", assignee: "dev" },
          tool_output: JSON.stringify({
            content: [{ text: JSON.stringify({ id: "ot-hook-1", title: "OT task", status: "open", assignee: "dev" }) }],
          }),
          session_id: "",
        },
        workspace.dir
      );

      expect(result.code).toBe(0);

      const found = await waitFor(() => {
        return mockServer.sentMessages.some(
          (m) => m.payload?.type === "task.created"
        );
      }, 5000);
      expect(found).toBe(true);

      const msg = mockServer.sentMessages.find(
        (m) => m.payload?.type === "task.created"
      );
      expect(msg.payload.task.id).toBe("ot-hook-1");
    });

    it("opentasks-mcp-used hook is no-op when MAP disabled", async () => {
      // Create a separate workspace with MAP disabled
      const noMapWorkspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7h-nomap-",
        config: { template: "gsd", map: { enabled: false } },
      });

      try {
        const beforeCount = mockServer.sentMessages.length;

        const result = await runHook(
          "opentasks-mcp-used",
          {
            tool_name: "opentasks__create_task",
            tool_input: { title: "Should not send" },
            tool_output: JSON.stringify({
              content: [{ text: JSON.stringify({ id: "skip-1", title: "Should not send" }) }],
            }),
            session_id: "",
          },
          noMapWorkspace.dir
        );

        expect(result.code).toBe(0);

        // Wait a moment, then verify no new messages
        await new Promise((r) => setTimeout(r, 1000));
        expect(mockServer.sentMessages.length).toBe(beforeCount);
      } finally {
        noMapWorkspace.cleanup();
      }
    });

    it("teammate-idle hook sends state command", async () => {
      // Write roles.json so matchRole can find it
      const mapDir = path.join(
        fs.realpathSync(workspace.dir),
        ".swarm", "claude-swarm", "tmp", "map"
      );
      fs.mkdirSync(mapDir, { recursive: true });
      fs.writeFileSync(
        path.join(mapDir, "roles.json"),
        JSON.stringify([
          { name: "executor", role: "executor" },
          { name: "verifier", role: "verifier" },
        ])
      );

      const result = await runHook(
        "teammate-idle",
        { teammate_name: "executor", session_id: "" },
        workspace.dir
      );

      expect(result.code).toBe(0);

      // State update should be sent (may or may not have agentId depending on registered agents)
      const found = await waitFor(() => {
        return mockServer.stateUpdates.length > 0;
      }, 5000);
      expect(found).toBe(true);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Full Pipeline (skill-tree → agent generation)
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "tier7: skill-tree → agent generation pipeline",
  { timeout: 15_000 },
  () => {
    let workspace;

    afterEach(() => {
      if (workspace) {
        workspace.cleanup();
        workspace = null;
      }
    });

    it("generateAgentMd embeds skill loadout from skill-loadouts.json", () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7h-pipeline-",
        config: { template: "gsd", skilltree: { enabled: true } },
      });

      // Write a cached skill-loadouts.json
      const cacheDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "teams", "gsd");
      fs.mkdirSync(cacheDir, { recursive: true });
      const loadouts = {
        executor: {
          content: "## Skill: Clean Code\n\nWrite clean, readable code.\n\n## Skill: TDD\n\nAlways write tests first.",
          profile: "implementation",
        },
      };
      fs.writeFileSync(
        path.join(cacheDir, "skill-loadouts.json"),
        JSON.stringify(loadouts)
      );

      // Generate AGENT.md for executor with the loadout
      const md = generateAgentMd({
        roleName: "executor",
        teamName: "gsd",
        position: "spawned",
        description: "Executor agent",
        tools: ["Read", "Write", "Bash"],
        skillContent: "# Role: executor\n\nExecute tasks.",
        manifest: {},
        skilltreeEnabled: true,
        skilltreeStatus: "ready",
        skillLoadout: loadouts.executor.content,
        skillProfile: loadouts.executor.profile,
      });

      expect(md).toContain("## Skills");
      expect(md).toContain("Clean Code");
      expect(md).toContain("TDD");
      expect(md).toContain("Write clean, readable code");
    });

    it("generateAgentMd works without skill loadout (no crash)", () => {
      const md = generateAgentMd({
        roleName: "executor",
        teamName: "gsd",
        position: "spawned",
        description: "Executor agent",
        tools: ["Read", "Write", "Bash"],
        skillContent: "# Role: executor\n\nExecute tasks.",
        manifest: {},
        skilltreeEnabled: false,
        skilltreeStatus: "disabled",
      });

      expect(md).toBeTruthy();
      expect(md).toContain("executor");
      // Should not have standalone "## Skills" section
      expect(md).not.toMatch(/^## Skills$/m);
    });

    it("skill-loadouts.json round-trips through file I/O correctly", () => {
      workspace = createWorkspace({
        tmpdir: SHORT_TMPDIR,
        prefix: "t7h-cache-",
        config: { template: "gsd", skilltree: { enabled: true } },
      });

      const cacheDir = path.join(workspace.dir, ".swarm", "claude-swarm", "tmp", "teams", "gsd");
      fs.mkdirSync(cacheDir, { recursive: true });

      const loadouts = {
        executor: { content: "## Skill: A\n\nContent A.", profile: "implementation" },
        verifier: { content: "## Skill: B\n\nContent B.", profile: "testing" },
        debugger: { content: "## Skill: C\n\nContent C.", profile: "debugging" },
      };

      // Write
      const filePath = path.join(cacheDir, "skill-loadouts.json");
      fs.writeFileSync(filePath, JSON.stringify(loadouts));

      // Read back
      const read = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(Object.keys(read)).toEqual(["executor", "verifier", "debugger"]);
      expect(read.executor.content).toContain("Skill: A");
      expect(read.executor.profile).toBe("implementation");
      expect(read.verifier.profile).toBe("testing");
      expect(read.debugger.profile).toBe("debugging");

      // Generate AGENT.md for each role from the cache
      for (const [role, data] of Object.entries(read)) {
        const md = generateAgentMd({
          roleName: role,
          teamName: "gsd",
          position: "spawned",
          description: `${role} agent`,
          tools: ["Read", "Bash"],
          skillContent: `# Role: ${role}\n\nDo ${role} things.`,
          manifest: {},
          skilltreeEnabled: true,
          skilltreeStatus: "ready",
          skillLoadout: data.content,
          skillProfile: data.profile,
        });

        expect(md).toContain("## Skills");
        expect(md).toContain(data.profile);
      }
    });
  }
);
