import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfig } from "./helpers.mjs";

// Mock the MAP SDK
const mockSend = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockCallExtension = vi.fn().mockResolvedValue(undefined);
const mockOnMessage = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  send: mockSend,
  disconnect: mockDisconnect,
  callExtension: mockCallExtension,
  onMessage: mockOnMessage,
});

vi.mock("@multi-agent-protocol/sdk", () => ({
  AgentConnection: { connect: (...args) => mockConnect(...args) },
}));

const { connectToMAP, fireAndForget, fireAndForgetTrajectory } = await import("../map-connection.mjs");

describe("map-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({
      send: mockSend,
      disconnect: mockDisconnect,
      callExtension: mockCallExtension,
      onMessage: mockOnMessage,
    });
  });

  describe("connectToMAP", () => {
    it("connects with correct parameters", async () => {
      await connectToMAP({ server: "ws://test:1234", scope: "swarm:team", systemId: "sys-1" });
      expect(mockConnect).toHaveBeenCalledOnce();
      const [server, opts] = mockConnect.mock.calls[0];
      expect(server).toBe("ws://test:1234");
      expect(opts.name).toBe("team-sidecar");
      expect(opts.role).toBe("sidecar");
      expect(opts.scopes).toEqual(["swarm:team"]);
      expect(opts.metadata.systemId).toBe("sys-1");
    });

    it("sets up onMessage callback when provided", async () => {
      const cb = vi.fn();
      await connectToMAP({ server: "ws://test", scope: "swarm:t", systemId: "s", onMessage: cb });
      expect(mockOnMessage).toHaveBeenCalledWith(cb);
    });

    it("returns connection on success", async () => {
      const conn = await connectToMAP({ server: "ws://test", scope: "swarm:t", systemId: "s" });
      expect(conn).not.toBeNull();
      expect(conn.send).toBe(mockSend);
    });

    it("returns null when connection fails", async () => {
      mockConnect.mockRejectedValueOnce(new Error("fail"));
      const conn = await connectToMAP({ server: "ws://test", scope: "swarm:t", systemId: "s" });
      expect(conn).toBeNull();
    });

    it("includes reconnection config", async () => {
      await connectToMAP({ server: "ws://test", scope: "swarm:t", systemId: "s" });
      const opts = mockConnect.mock.calls[0][1];
      expect(opts.reconnection.enabled).toBe(true);
    });

    it("includes trajectory capability", async () => {
      await connectToMAP({ server: "ws://test", scope: "swarm:t", systemId: "s" });
      const opts = mockConnect.mock.calls[0][1];
      expect(opts.capabilities.trajectory.canReport).toBe(true);
    });
  });

  describe("fireAndForget", () => {
    it("creates connection, sends event, disconnects", async () => {
      const config = makeConfig({ mapEnabled: true, scope: "swarm:test" });
      await fireAndForget(config, { type: "test.event" });
      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockSend).toHaveBeenCalledOnce();
      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it("uses hook agent name", async () => {
      const config = makeConfig({ template: "gsd" });
      await fireAndForget(config, { type: "test" });
      const opts = mockConnect.mock.calls[0][1];
      expect(opts.name).toContain("-hook");
    });

    it("silently fails when connection fails", async () => {
      mockConnect.mockRejectedValueOnce(new Error("down"));
      const config = makeConfig();
      await expect(fireAndForget(config, { type: "test" })).resolves.toBeUndefined();
    });
  });

  describe("fireAndForgetTrajectory", () => {
    it("calls trajectory/checkpoint extension when available", async () => {
      const config = makeConfig();
      const checkpoint = { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: {} };
      await fireAndForgetTrajectory(config, checkpoint);
      expect(mockCallExtension).toHaveBeenCalledWith("trajectory/checkpoint", { checkpoint });
    });

    it("falls back to broadcast when extension fails", async () => {
      mockCallExtension.mockRejectedValueOnce(new Error("not supported"));
      const config = makeConfig();
      const checkpoint = { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: { phase: "active" } };
      await fireAndForgetTrajectory(config, checkpoint);
      expect(mockSend).toHaveBeenCalled();
      const [, payload] = mockSend.mock.calls[0];
      expect(payload.type).toBe("trajectory.checkpoint");
      expect(payload.checkpoint.id).toBe("cp1");
      expect(payload.checkpoint.agentId).toBe("a");
      expect(payload.checkpoint.metadata).toEqual({ phase: "active" });
    });

    it("disconnects after sending", async () => {
      const config = makeConfig();
      await fireAndForgetTrajectory(config, { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: {} });
      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it("silently fails on error", async () => {
      mockConnect.mockRejectedValueOnce(new Error("down"));
      const config = makeConfig();
      await expect(
        fireAndForgetTrajectory(config, { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: {} })
      ).resolves.toBeUndefined();
    });
  });
});
