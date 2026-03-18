import { describe, it, expect, vi } from "vitest";
import { generateAgentMd } from "../agent-generator.mjs";
import { buildCapabilitiesContext } from "../context-output.mjs";
import { createCommandHandler, respond } from "../sidecar-server.mjs";

// Minimal manifest for agent generation
const minManifest = {
  name: "gsd",
  topology: { root: { role: "coordinator" } },
  communication: {},
};

describe("inbox integration — agent identity in AGENT.md", () => {
  it("embeds inbox identity section when inboxEnabled is true", () => {
    const md = generateAgentMd({
      roleName: "executor",
      teamName: "gsd",
      position: "spawned",
      description: "Executes tasks",
      tools: ["Read", "Bash"],
      skillContent: "# Role: executor",
      manifest: minManifest,
      inboxEnabled: true,
    });

    expect(md).toContain("## Your Agent Inbox Identity");
    expect(md).toContain("**gsd-executor**");
    expect(md).toContain('agent-inbox__check_inbox(agentId: "gsd-executor")');
    expect(md).toContain('agent-inbox__send_message(from: "gsd-executor"');
    expect(md).toContain("agent-inbox__read_thread");
    expect(md).toContain("agent-inbox__list_agents");
  });

  it("does not embed inbox identity when inboxEnabled is false", () => {
    const md = generateAgentMd({
      roleName: "executor",
      teamName: "gsd",
      position: "spawned",
      description: "Executes tasks",
      tools: ["Read", "Bash"],
      skillContent: "# Role: executor",
      manifest: minManifest,
      inboxEnabled: false,
    });

    expect(md).not.toContain("Your Agent Inbox Identity");
    expect(md).not.toContain("agent-inbox__check_inbox");
  });

  it("uses correct ID format: teamName-roleName", () => {
    const md = generateAgentMd({
      roleName: "verifier",
      teamName: "my-team",
      position: "spawned",
      description: "Verifies",
      tools: ["Read"],
      skillContent: "# Role: verifier",
      manifest: minManifest,
      inboxEnabled: true,
    });

    expect(md).toContain("**my-team-verifier**");
    expect(md).toContain('agentId: "my-team-verifier"');
    expect(md).toContain('from: "my-team-verifier"');
  });

  it("mentions federated addressing", () => {
    const md = generateAgentMd({
      roleName: "executor",
      teamName: "gsd",
      position: "spawned",
      description: "Executes",
      tools: ["Read"],
      skillContent: "# Role: executor",
      manifest: minManifest,
      inboxEnabled: true,
    });

    expect(md).toContain("agent@system");
  });

  it("AGENT.md frontmatter name matches inbox ID format", () => {
    const md = generateAgentMd({
      roleName: "executor",
      teamName: "gsd",
      position: "spawned",
      description: "Executes",
      tools: ["Read"],
      skillContent: "# Role: executor",
      manifest: minManifest,
      inboxEnabled: true,
    });

    // Frontmatter should have same format as inbox ID
    expect(md).toContain("name: gsd-executor");
    expect(md).toContain("**gsd-executor**");
  });
});

describe("inbox integration — capabilities context", () => {
  it("includes detailed inbox MCP tool instructions when enabled", () => {
    const ctx = buildCapabilitiesContext({
      inboxEnabled: true,
    });

    expect(ctx).toContain("agent-inbox__check_inbox");
    expect(ctx).toContain("agent-inbox__send_message");
    expect(ctx).toContain("agent-inbox__read_thread");
    expect(ctx).toContain("agent-inbox__list_agents");
    expect(ctx).toContain("cross-system messages");
    expect(ctx).toContain("threaded conversations");
  });

  it("omits inbox tool instructions when disabled", () => {
    const ctx = buildCapabilitiesContext({
      inboxEnabled: false,
    });

    expect(ctx).not.toContain("agent-inbox__check_inbox");
    expect(ctx).not.toContain("Structured messaging");
  });

  it("distinguishes between SendMessage and inbox use cases", () => {
    const ctx = buildCapabilitiesContext({
      inboxEnabled: true,
    });

    expect(ctx).toContain("Use inbox for:");
    expect(ctx).toContain("Use `SendMessage` for:");
  });

  it("mentions federated addressing in tool description", () => {
    const ctx = buildCapabilitiesContext({
      inboxEnabled: true,
    });

    expect(ctx).toContain("agent@system");
  });
});

describe("inbox integration — sidecar websocket mode agent registration", () => {
  it("registers agent in inbox storage during websocket spawn", async () => {
    // Mock connection that returns agent data
    const mockConn = {
      spawn: vi.fn().mockResolvedValue({ agentId: "gsd-exec", name: "exec" }),
      callExtension: vi.fn().mockResolvedValue({}),
      updateState: vi.fn().mockResolvedValue(undefined),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const mockInboxStorage = {
      putAgent: vi.fn(),
    };
    const mockInboxInstance = { storage: mockInboxStorage };

    const registeredAgents = new Map();
    const handler = createCommandHandler(mockConn, "swarm:gsd", registeredAgents, {
      inboxInstance: mockInboxInstance,
      transportMode: "websocket",
    });

    const client = { write: vi.fn() };
    await handler({
      action: "spawn",
      agent: {
        agentId: "gsd-executor",
        name: "executor",
        role: "executor",
        scopes: ["swarm:gsd"],
        metadata: { template: "gsd" },
      },
    }, client);

    // Should have called conn.spawn (MAP SDK)
    expect(mockConn.spawn).toHaveBeenCalledOnce();

    // Should also register in inbox storage
    expect(mockInboxStorage.putAgent).toHaveBeenCalledOnce();
    const agentArg = mockInboxStorage.putAgent.mock.calls[0][0];
    expect(agentArg.agent_id).toBe("gsd-executor");
    expect(agentArg.status).toBe("active");
    expect(agentArg.scope).toBe("swarm:gsd");

    // Should be in registered agents map
    expect(registeredAgents.has("gsd-executor")).toBe(true);
  });

  it("marks agent disconnected in inbox storage during websocket done", async () => {
    const mockConn = {
      spawn: vi.fn().mockResolvedValue({}),
      callExtension: vi.fn().mockResolvedValue({}),
      updateState: vi.fn(),
      updateMetadata: vi.fn(),
      send: vi.fn(),
    };

    const mockInboxStorage = {
      putAgent: vi.fn(),
    };
    const mockInboxInstance = { storage: mockInboxStorage };

    const registeredAgents = new Map();
    registeredAgents.set("gsd-executor", { name: "executor", role: "executor" });

    const handler = createCommandHandler(mockConn, "swarm:gsd", registeredAgents, {
      inboxInstance: mockInboxInstance,
      transportMode: "websocket",
    });

    const client = { write: vi.fn() };
    await handler({
      action: "done",
      agentId: "gsd-executor",
      reason: "completed",
    }, client);

    // Should have called MAP unregister
    expect(mockConn.callExtension).toHaveBeenCalledOnce();

    // Should mark disconnected in inbox storage
    expect(mockInboxStorage.putAgent).toHaveBeenCalledOnce();
    const agentArg = mockInboxStorage.putAgent.mock.calls[0][0];
    expect(agentArg.agent_id).toBe("gsd-executor");
    expect(agentArg.status).toBe("disconnected");

    // Should be removed from registered agents
    expect(registeredAgents.has("gsd-executor")).toBe(false);
  });

  it("does not fail when inbox storage is not available in websocket spawn", async () => {
    const mockConn = {
      spawn: vi.fn().mockResolvedValue({}),
      callExtension: vi.fn(),
      updateState: vi.fn(),
      updateMetadata: vi.fn(),
      send: vi.fn(),
    };

    const registeredAgents = new Map();
    const handler = createCommandHandler(mockConn, "swarm:gsd", registeredAgents, {
      // No inboxInstance provided
      transportMode: "websocket",
    });

    const client = { write: vi.fn() };

    // Should not throw
    await handler({
      action: "spawn",
      agent: {
        agentId: "gsd-worker",
        name: "worker",
        role: "worker",
        scopes: ["swarm:gsd"],
        metadata: {},
      },
    }, client);

    expect(mockConn.spawn).toHaveBeenCalledOnce();
    expect(registeredAgents.has("gsd-worker")).toBe(true);
  });
});

describe("inbox integration — agent ID consistency", () => {
  it("AGENT.md name matches the ID format used by sidecar and hooks", () => {
    // The AGENT.md frontmatter uses teamName-roleName
    const teamName = "gsd";
    const roleName = "executor";
    const expectedId = `${teamName}-${roleName}`;

    // Generated AGENT.md
    const md = generateAgentMd({
      roleName,
      teamName,
      position: "spawned",
      description: "test",
      tools: [],
      skillContent: "",
      manifest: minManifest,
      inboxEnabled: true,
    });

    // Frontmatter name
    expect(md).toContain(`name: ${expectedId}`);
    // Inbox identity
    expect(md).toContain(`**${expectedId}**`);
    // check_inbox instruction
    expect(md).toContain(`agentId: "${expectedId}"`);
  });

  it("main agent ID follows teamName-main convention", () => {
    // This is what bootstrap.mjs and map-hook.mjs use
    const teamName = "gsd";
    const mainAgentId = `${teamName}-main`;
    expect(mainAgentId).toBe("gsd-main");
  });
});
