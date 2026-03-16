import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  makeTmpDir,
  writeFile,
  makeTeamYaml,
  makeHookData,
  makeOpentasksMcpHookData,
  cleanupTmpDir,
} from "./helpers.mjs";

// ── 1. Agent generation with opentasks enabled ─────────────────────────────────

describe("integration: agent generation with opentasks enabled", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  it("generates AGENT.md without native task tools when opentasks is enabled", async () => {
    const { generateAllAgents } = await import("../agent-generator.mjs");
    const templateDir = path.join(tmpDir, "template");
    const outputDir = path.join(tmpDir, "agents");
    writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test-team", roles: ["lead", "worker"] }));

    const result = await generateAllAgents(templateDir, outputDir, { opentasksEnabled: true });
    expect(result.success).toBe(true);
    expect(result.roles).toEqual(["lead", "worker"]);

    for (const role of ["lead", "worker"]) {
      const agentMd = fs.readFileSync(path.join(outputDir, role, "AGENT.md"), "utf-8");

      // Frontmatter tools should NOT contain native task tools
      const frontmatter = agentMd.split("---")[1];
      expect(frontmatter).not.toContain("TaskCreate");
      expect(frontmatter).not.toContain("TaskUpdate");
      expect(frontmatter).not.toContain("TaskList");

      // Frontmatter tools SHOULD contain SendMessage
      expect(frontmatter).toContain("SendMessage");

      // Body should mention opentasks MCP tools
      expect(agentMd).toContain("opentasks MCP tools");

      // Body task management section should NOT mention native tools
      const taskSection = agentMd.split("### Task Management")[1].split("###")[0];
      expect(taskSection).not.toContain("TaskCreate");
      expect(taskSection).not.toContain("TaskUpdate");
    }
  });

  it("includes opentasks__create_task instruction for root-position roles", async () => {
    const { generateAgentMd, determineTools } = await import("../agent-generator.mjs");
    const tools = determineTools("lead", { topology: {} }, "root", { opentasksEnabled: true });
    const md = generateAgentMd({
      roleName: "lead",
      teamName: "test-team",
      position: "root",
      description: "The lead",
      tools,
      skillContent: "# Lead",
      manifest: {},
      opentasksEnabled: true,
    });

    expect(md).toContain("opentasks__create_task");
    expect(tools).not.toContain("TaskCreate");
    expect(tools).not.toContain("TaskList");
    expect(tools).toContain("SendMessage");
  });
});

// ── 2. Agent generation with opentasks disabled (default) ───────────────────────

describe("integration: agent generation with opentasks disabled", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanupTmpDir(tmpDir); });

  it("generates AGENT.md with native task tools when opentasks is not enabled", async () => {
    const { generateAllAgents } = await import("../agent-generator.mjs");
    const templateDir = path.join(tmpDir, "template");
    const outputDir = path.join(tmpDir, "agents");
    writeFile(templateDir, "team.yaml", makeTeamYaml({ name: "test-team", roles: ["lead", "worker"] }));

    const result = await generateAllAgents(templateDir, outputDir);
    expect(result.success).toBe(true);

    // Worker should have TaskList, TaskUpdate, SendMessage but NOT TaskCreate
    const workerMd = fs.readFileSync(path.join(outputDir, "worker", "AGENT.md"), "utf-8");
    const workerFrontmatter = workerMd.split("---")[1];
    expect(workerFrontmatter).toContain("TaskList");
    expect(workerFrontmatter).toContain("TaskUpdate");
    expect(workerFrontmatter).toContain("SendMessage");
    // In fallback mode all roles get TaskCreate in the tools list
    expect(workerFrontmatter).toContain("TaskCreate");

    // Body should mention native task tools in capabilities
    expect(workerMd).toContain("Claude Code native task tools");
  });

  it("root and companion roles include TaskCreate in determineTools", async () => {
    const { determineTools } = await import("../agent-generator.mjs");
    const manifest = { topology: {} };

    const rootTools = determineTools("lead", manifest, "root");
    expect(rootTools).toContain("TaskCreate");
    expect(rootTools).toContain("TaskList");
    expect(rootTools).toContain("TaskUpdate");
    expect(rootTools).toContain("SendMessage");

    const companionTools = determineTools("helper", manifest, "companion");
    expect(companionTools).toContain("TaskCreate");

    const spawnedTools = determineTools("worker", manifest, "spawned");
    expect(spawnedTools).not.toContain("TaskCreate");
    expect(spawnedTools).toContain("TaskList");
    expect(spawnedTools).toContain("TaskUpdate");
  });
});

// ── 3. Native task hook → MAP bridge events (end-to-end) ────────────────────────

describe("integration: native task hook → MAP bridge events", () => {
  let sidecarCommands;

  beforeEach(async () => {
    sidecarCommands = [];
    vi.doMock("../sidecar-client.mjs", () => ({
      sendToSidecar: vi.fn(async (cmd) => { sidecarCommands.push(cmd); return true; }),
      ensureSidecar: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../paths.mjs", () => ({
      sessionPaths: vi.fn(() => ({ socketPath: "/tmp/s.sock", inboxSocketPath: "/tmp/i.sock" })),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("buildOpentasksBridgeCommands for create_task → sendCommand → sidecar receives correct payloads", async () => {
    const { buildOpentasksBridgeCommands, sendCommand } = await import("../map-events.mjs");

    const hookData = {
      tool_name: "mcp__opentasks__create_task",
      tool_input: { title: "Implement feature X", assignee: "gsd-executor" },
      tool_output: JSON.stringify({
        content: [{ text: JSON.stringify({ id: "task-100", title: "Implement feature X", status: "open", assignee: "gsd-executor" }) }],
      }),
    };

    const cmds = buildOpentasksBridgeCommands(hookData);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].action).toBe("bridge-task-created");
    expect(cmds[1].action).toBe("bridge-task-assigned");

    // Send each command through sendCommand
    const config = { map: { enabled: true } };
    for (const cmd of cmds) {
      await sendCommand(config, cmd, null);
    }

    expect(sidecarCommands).toHaveLength(2);
    expect(sidecarCommands[0].action).toBe("bridge-task-created");
    expect(sidecarCommands[0].task.id).toBe("task-100");
    expect(sidecarCommands[0].task.title).toBe("Implement feature X");
    expect(sidecarCommands[0].task.assignee).toBe("gsd-executor");
    expect(sidecarCommands[1].action).toBe("bridge-task-assigned");
    expect(sidecarCommands[1].taskId).toBe("task-100");
    expect(sidecarCommands[1].assignee).toBe("gsd-executor");
  });

  it("buildOpentasksBridgeCommands for update_task with status change → bridge-task-status → sendCommand → verify", async () => {
    const { buildOpentasksBridgeCommands, sendCommand } = await import("../map-events.mjs");

    const hookData = {
      tool_name: "mcp__opentasks__update_task",
      tool_input: { id: "task-200", status: "completed" },
      tool_output: JSON.stringify({
        content: [{ text: JSON.stringify({ id: "task-200", status: "completed", assignee: "gsd-worker" }) }],
      }),
    };

    const cmds = buildOpentasksBridgeCommands(hookData);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].action).toBe("bridge-task-status");

    const config = { map: { enabled: true } };
    for (const cmd of cmds) {
      await sendCommand(config, cmd, null);
    }

    expect(sidecarCommands).toHaveLength(1);
    expect(sidecarCommands[0].taskId).toBe("task-200");
    expect(sidecarCommands[0].current).toBe("completed");
    expect(sidecarCommands[0].agentId).toBe("gsd-worker");
  });

  it("handleTaskCreated creates task in opentasks + emits bridge events", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue({ id: "ot-task-1" });
    const mockFindSocketPath = vi.fn().mockReturnValue("/tmp/ot.sock");
    vi.doMock("../opentasks-client.mjs", () => ({
      createTask: mockCreateTask,
      findSocketPath: mockFindSocketPath,
    }));

    // Must re-import after adding the opentasks mock
    const { handleTaskCreated } = await import("../map-events.mjs");
    const hookData = makeHookData({ prompt: "Build the feature" });
    const config = { map: { enabled: true } };

    await handleTaskCreated(config, hookData, "gsd", "executor", "test-agent", "sess-1");

    // Verify opentasks was called
    expect(mockCreateTask).toHaveBeenCalledWith("/tmp/ot.sock", expect.objectContaining({
      title: "Build the feature",
      status: "open",
      assignee: "gsd-executor",
    }));

    // Verify sidecar received bridge commands
    const createdCmd = sidecarCommands.find((c) => c.action === "bridge-task-created");
    expect(createdCmd).toBeDefined();
    expect(createdCmd.task.id).toBe("ot-task-1");
    expect(createdCmd.task.title).toBe("Build the feature");
    expect(createdCmd.task.assignee).toBe("gsd-executor");

    const assignedCmd = sidecarCommands.find((c) => c.action === "bridge-task-assigned");
    expect(assignedCmd).toBeDefined();
    expect(assignedCmd.taskId).toBe("ot-task-1");
    expect(assignedCmd.assignee).toBe("gsd-executor");
  });
});

// ── 4. Context output with opentasks ─────────────────────────────────────────────

describe("integration: context output with opentasks", () => {
  it("formatBootstrapContext mentions opentasks MCP tools when enabled and connected", async () => {
    const { formatBootstrapContext } = await import("../context-output.mjs");

    const output = formatBootstrapContext({
      template: "gsd",
      opentasksEnabled: true,
      opentasksStatus: "connected",
    });

    expect(output).toContain("opentasks MCP tools");
    expect(output).toContain("opentasks__create_task");
  });

  it("formatBootstrapContext does not mention opentasks tools when not enabled", async () => {
    const { formatBootstrapContext } = await import("../context-output.mjs");

    const output = formatBootstrapContext({
      template: "gsd",
    });

    expect(output).not.toContain("opentasks MCP tools");
    expect(output).not.toContain("opentasks__create_task");
  });

  it("formatTeamLoadedContext mentions opentasks when enabled and connected", async () => {
    const { formatTeamLoadedContext } = await import("../context-output.mjs");

    const output = formatTeamLoadedContext(
      "/tmp/agents",
      "/tmp/template",
      "gsd",
      { opentasksEnabled: true, opentasksStatus: "connected" },
    );

    expect(output).toContain("opentasks MCP tools");
    expect(output).toContain("opentasks__create_task");
  });

  it("formatTeamLoadedContext mentions native task tools when opentasks not enabled", async () => {
    const { formatTeamLoadedContext } = await import("../context-output.mjs");

    const output = formatTeamLoadedContext(
      "/tmp/agents",
      "/tmp/template",
      "gsd",
    );

    expect(output).toContain("Claude Code native task tools");
    expect(output).toContain("TaskCreate");
    expect(output).not.toContain("opentasks MCP tools");
  });

  it("formatBootstrapContext with opentasksEnabled and status 'enabled' shows opentasks tools", async () => {
    const { formatBootstrapContext } = await import("../context-output.mjs");

    const output = formatBootstrapContext({
      template: "gsd",
      opentasksEnabled: true,
      opentasksStatus: "enabled",
    });

    expect(output).toContain("opentasks MCP tools");
  });
});

// ── 5. Opentasks MCP bridge full flow ────────────────────────────────────────────

describe("integration: opentasks MCP bridge full flow", () => {
  let sidecarCommands;

  beforeEach(async () => {
    sidecarCommands = [];
    vi.doMock("../sidecar-client.mjs", () => ({
      sendToSidecar: vi.fn(async (cmd) => { sidecarCommands.push(cmd); return true; }),
      ensureSidecar: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../paths.mjs", () => ({
      sessionPaths: vi.fn(() => ({ socketPath: "/tmp/s.sock", inboxSocketPath: "/tmp/i.sock" })),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("PostToolUse create_task with realistic MCP tool_output → bridge commands → sidecar", async () => {
    const { buildOpentasksBridgeCommands, sendCommand } = await import("../map-events.mjs");

    // Simulate realistic PostToolUse hook data for opentasks create_task
    const mcpOutput = {
      content: [{
        text: JSON.stringify({
          id: "task-abc-123",
          title: "Refactor authentication module",
          status: "open",
          assignee: "gsd-developer",
          metadata: { source: "opentasks" },
        }),
      }],
    };

    const hookData = {
      session_id: "sess-42",
      tool_name: "mcp__opentasks__create_task",
      tool_input: {
        title: "Refactor authentication module",
        assignee: "gsd-developer",
        status: "open",
      },
      tool_output: JSON.stringify(mcpOutput),
    };

    const cmds = buildOpentasksBridgeCommands(hookData);
    expect(cmds).toHaveLength(2);

    // Verify task ID comes from tool_output, not empty
    expect(cmds[0].task.id).toBe("task-abc-123");
    expect(cmds[0].task.title).toBe("Refactor authentication module");

    // Send each command through sendCommand to sidecar
    const config = { map: { enabled: true } };
    for (const cmd of cmds) {
      await sendCommand(config, cmd, "sess-42");
    }

    // Verify sidecar received bridge-task-created with correct data
    expect(sidecarCommands).toHaveLength(2);
    expect(sidecarCommands[0].action).toBe("bridge-task-created");
    expect(sidecarCommands[0].task.id).toBe("task-abc-123");
    expect(sidecarCommands[0].task.title).toBe("Refactor authentication module");
    expect(sidecarCommands[0].task.assignee).toBe("gsd-developer");
    expect(sidecarCommands[0].agentId).toBe("gsd-developer");

    expect(sidecarCommands[1].action).toBe("bridge-task-assigned");
    expect(sidecarCommands[1].taskId).toBe("task-abc-123");
    expect(sidecarCommands[1].assignee).toBe("gsd-developer");
  });

  it("PostToolUse update_task with status completed → bridge-task-status → sidecar", async () => {
    const { buildOpentasksBridgeCommands, sendCommand } = await import("../map-events.mjs");

    const mcpOutput = {
      content: [{
        text: JSON.stringify({
          id: "task-xyz-789",
          status: "completed",
          assignee: "gsd-executor",
        }),
      }],
    };

    const hookData = {
      session_id: "sess-99",
      tool_name: "mcp__opentasks__update_task",
      tool_input: { id: "task-xyz-789", status: "completed" },
      tool_output: JSON.stringify(mcpOutput),
    };

    const cmds = buildOpentasksBridgeCommands(hookData);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].action).toBe("bridge-task-status");
    expect(cmds[0].taskId).toBe("task-xyz-789");
    expect(cmds[0].current).toBe("completed");

    const config = { map: { enabled: true } };
    await sendCommand(config, cmds[0], "sess-99");

    expect(sidecarCommands).toHaveLength(1);
    expect(sidecarCommands[0].action).toBe("bridge-task-status");
    expect(sidecarCommands[0].taskId).toBe("task-xyz-789");
    expect(sidecarCommands[0].current).toBe("completed");
    expect(sidecarCommands[0].agentId).toBe("gsd-executor");
  });
});

// ── 6. Native task created → MAP event flow ──────────────────────────────────────

describe("integration: native task created → MAP event flow", () => {
  let sidecarCommands;

  beforeEach(async () => {
    sidecarCommands = [];
    vi.doMock("../sidecar-client.mjs", () => ({
      sendToSidecar: vi.fn(async (cmd) => { sidecarCommands.push(cmd); return true; }),
      ensureSidecar: vi.fn().mockResolvedValue(false),
    }));
    vi.doMock("../paths.mjs", () => ({
      sessionPaths: vi.fn(() => ({ socketPath: "/tmp/s.sock", inboxSocketPath: "/tmp/i.sock" })),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("native TaskCreate hookData → sendCommand with bridge-task-created → sidecar has correct task data", async () => {
    const { sendCommand } = await import("../map-events.mjs");

    // Simulate building a bridge-task-created command from native TaskCreate hook data
    const hookData = {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication bug", description: "Auth tokens expire too soon" },
      tool_output: { id: "native-task-001" },
      tool_use_id: "tu-native-1",
    };

    const bridgeCmd = {
      action: "bridge-task-created",
      task: {
        id: hookData.tool_output.id,
        title: hookData.tool_input.subject,
        status: "open",
        assignee: "gsd-lead",
      },
      agentId: "gsd-lead",
    };

    const config = { map: { enabled: true } };
    await sendCommand(config, bridgeCmd, "sess-native-1");

    expect(sidecarCommands).toHaveLength(1);
    expect(sidecarCommands[0].action).toBe("bridge-task-created");
    expect(sidecarCommands[0].task.id).toBe("native-task-001");
    expect(sidecarCommands[0].task.title).toBe("Fix authentication bug");
    expect(sidecarCommands[0].task.status).toBe("open");
    expect(sidecarCommands[0].agentId).toBe("gsd-lead");
  });

  it("native TaskUpdate status change → bridge-task-status → sidecar has correct status transition", async () => {
    const { sendCommand } = await import("../map-events.mjs");

    const bridgeCmd = {
      action: "bridge-task-status",
      taskId: "native-task-002",
      previous: "in_progress",
      current: "completed",
      agentId: "gsd-executor",
    };

    const config = { map: { enabled: true } };
    await sendCommand(config, bridgeCmd, "sess-native-2");

    expect(sidecarCommands).toHaveLength(1);
    expect(sidecarCommands[0].action).toBe("bridge-task-status");
    expect(sidecarCommands[0].taskId).toBe("native-task-002");
    expect(sidecarCommands[0].previous).toBe("in_progress");
    expect(sidecarCommands[0].current).toBe("completed");
    expect(sidecarCommands[0].agentId).toBe("gsd-executor");
  });

  it("buildTaskSyncPayload + sendCommand emit flow with native TaskCreate data", async () => {
    const { buildTaskSyncPayload, emitPayload } = await import("../map-events.mjs");

    const hookData = {
      tool_input: { taskId: "native-task-003", subject: "Add logging", status: "pending" },
    };

    const payload = buildTaskSyncPayload(hookData, "gsd");
    expect(payload.type).toBe("task.sync");
    expect(payload.uri).toBe("claude://gsd/native-task-003");
    expect(payload.status).toBe("open"); // "pending" maps to "open"
    expect(payload.subject).toBe("Add logging");

    const config = { map: { enabled: true } };
    await emitPayload(config, payload, undefined, "sess-native-3");

    expect(sidecarCommands).toHaveLength(1);
    expect(sidecarCommands[0].action).toBe("emit");
    expect(sidecarCommands[0].event.type).toBe("task.sync");
    expect(sidecarCommands[0].event.uri).toBe("claude://gsd/native-task-003");
    expect(sidecarCommands[0].event.status).toBe("open");
  });
});
