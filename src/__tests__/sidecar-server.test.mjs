import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import net from "net";
import { createSocketServer, createCommandHandler, respond } from "../sidecar-server.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("sidecar-server", () => {
  describe("respond", () => {
    it("writes JSON + newline to client", () => {
      const client = { write: vi.fn() };
      respond(client, { ok: true });
      expect(client.write).toHaveBeenCalledWith('{"ok":true}\n');
    });

    it("does not throw when client write fails", () => {
      const client = { write: vi.fn(() => { throw new Error("closed"); }) };
      expect(() => respond(client, { ok: true })).not.toThrow();
    });
  });

  describe("createSocketServer", () => {
    let tmpDir;
    let socketPath;
    let server;
    beforeEach(() => {
      tmpDir = makeTmpDir();
      socketPath = path.join(tmpDir, "test.sock");
    });
    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }
      cleanupTmpDir(tmpDir);
    });

    it("creates a UNIX socket server at the specified path", async () => {
      const onCommand = vi.fn();
      server = createSocketServer(socketPath, onCommand);
      await new Promise((resolve) => server.on("listening", resolve));
      // Connect a test client
      const client = net.createConnection(socketPath);
      await new Promise((resolve) => client.on("connect", resolve));
      client.destroy();
    });

    it("calls onCommand for valid JSON line", async () => {
      const onCommand = vi.fn();
      server = createSocketServer(socketPath, onCommand);
      await new Promise((resolve) => server.on("listening", resolve));

      const client = net.createConnection(socketPath);
      await new Promise((resolve) => client.on("connect", resolve));
      client.write('{"action":"ping"}\n');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(onCommand.mock.calls[0][0]).toEqual({ action: "ping" });
      client.destroy();
    });

    it("parses multiple commands in one data chunk", async () => {
      const onCommand = vi.fn();
      server = createSocketServer(socketPath, onCommand);
      await new Promise((resolve) => server.on("listening", resolve));

      const client = net.createConnection(socketPath);
      await new Promise((resolve) => client.on("connect", resolve));
      client.write('{"action":"a"}\n{"action":"b"}\n');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onCommand).toHaveBeenCalledTimes(2);
      client.destroy();
    });
  });

  describe("createCommandHandler", () => {
    let mockConnection;
    let mockClient;
    let registeredAgents;
    let handler;

    beforeEach(() => {
      mockConnection = {
        send: vi.fn().mockResolvedValue(undefined),
        spawn: vi.fn().mockResolvedValue({ agentId: "spawned-1" }),
        updateState: vi.fn().mockResolvedValue(undefined),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        callExtension: vi.fn().mockResolvedValue(undefined),
      };
      mockClient = { write: vi.fn() };
      registeredAgents = new Map();
      handler = createCommandHandler(mockConnection, "swarm:test", registeredAgents);
    });

    describe("emit", () => {
      it("sends event via connection.send with scope", async () => {
        await handler({ action: "emit", event: { type: "test" }, meta: {} }, mockClient);
        expect(mockConnection.send).toHaveBeenCalledWith(
          { scope: "swarm:test" },
          { type: "test" },
          {}
        );
      });

      it("responds {ok: true}", async () => {
        await handler({ action: "emit", event: {} }, mockClient);
        expect(mockClient.write).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
      });
    });

    describe("send", () => {
      it("sends via connection.send with to, payload, meta", async () => {
        await handler({
          action: "send", to: { agentId: "a" }, payload: "hello", meta: { priority: "high" },
        }, mockClient);
        expect(mockConnection.send).toHaveBeenCalledWith(
          { agentId: "a" }, "hello", { priority: "high" }
        );
      });
    });

    // ── SDK-native agent lifecycle ────────────────────────────────────────

    describe("spawn", () => {
      it("calls conn.spawn() with agent config", async () => {
        await handler({
          action: "spawn",
          agent: { agentId: "gsd-exec", name: "exec", role: "executor", scopes: ["s"], metadata: { template: "gsd" } },
        }, mockClient);
        expect(mockConnection.spawn).toHaveBeenCalledWith({
          agentId: "gsd-exec",
          name: "exec",
          role: "executor",
          scopes: ["s"],
          metadata: { template: "gsd" },
        });
      });

      it("adds agent to registeredAgents map", async () => {
        await handler({
          action: "spawn",
          agent: { agentId: "gsd-exec", name: "exec", role: "executor", scopes: ["s"], metadata: {} },
        }, mockClient);
        expect(registeredAgents.has("gsd-exec")).toBe(true);
        expect(registeredAgents.get("gsd-exec")).toEqual({ name: "exec", role: "executor", metadata: {} });
      });

      it("responds with {ok: true, agent} on success", async () => {
        mockConnection.spawn.mockResolvedValueOnce({ agentId: "gsd-exec" });
        await handler({
          action: "spawn",
          agent: { agentId: "gsd-exec", name: "exec", role: "executor", scopes: ["s"], metadata: {} },
        }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
        expect(written.agent).toEqual({ agentId: "gsd-exec" });
      });

      it("responds with {ok: false} when spawn throws", async () => {
        mockConnection.spawn.mockRejectedValueOnce(new Error("quota exceeded"));
        await handler({
          action: "spawn",
          agent: { agentId: "gsd-exec", name: "exec", role: "executor", scopes: ["s"], metadata: {} },
        }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
      });

      it("responds {ok: false} when no connection", async () => {
        const nullHandler = createCommandHandler(null, "swarm:test", registeredAgents);
        await nullHandler({
          action: "spawn",
          agent: { agentId: "a", name: "a", role: "r", scopes: [], metadata: {} },
        }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
      });
    });

    describe("done", () => {
      it("calls callExtension to unregister agent", async () => {
        registeredAgents.set("gsd-exec", { name: "exec", role: "executor" });
        await handler({ action: "done", agentId: "gsd-exec", reason: "completed" }, mockClient);
        expect(mockConnection.callExtension).toHaveBeenCalledWith(
          "map/agents/unregister",
          { agentId: "gsd-exec", reason: "completed" }
        );
      });

      it("removes agentId from registeredAgents", async () => {
        registeredAgents.set("gsd-exec", { name: "exec" });
        await handler({ action: "done", agentId: "gsd-exec" }, mockClient);
        expect(registeredAgents.has("gsd-exec")).toBe(false);
      });

      it("defaults reason to 'completed'", async () => {
        await handler({ action: "done", agentId: "gsd-exec" }, mockClient);
        expect(mockConnection.callExtension).toHaveBeenCalledWith(
          "map/agents/unregister",
          { agentId: "gsd-exec", reason: "completed" }
        );
      });

      it("responds {ok: true} even if agent not found", async () => {
        mockConnection.callExtension.mockRejectedValueOnce(new Error("not found"));
        await handler({ action: "done", agentId: "gone" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
      });
    });

    // ── Trajectory ────────────────────────────────────────────────────────

    describe("trajectory-checkpoint", () => {
      it("calls callExtension on success", async () => {
        const cp = { id: "cp1", metadata: {} };
        await handler({ action: "trajectory-checkpoint", checkpoint: cp }, mockClient);
        expect(mockConnection.callExtension).toHaveBeenCalledWith(
          "trajectory/checkpoint", { checkpoint: cp }
        );
      });

      it("responds with method: trajectory on success", async () => {
        await handler({ action: "trajectory-checkpoint", checkpoint: { id: "cp1", metadata: {} } }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.method).toBe("trajectory");
      });

      it("falls back to broadcast with trajectory.checkpoint payload when callExtension throws", async () => {
        mockConnection.callExtension.mockRejectedValueOnce(new Error("not supported"));
        const cp = { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: { phase: "active" } };
        await handler({ action: "trajectory-checkpoint", checkpoint: cp }, mockClient);
        expect(mockConnection.send).toHaveBeenCalled();
        const [, payload] = mockConnection.send.mock.calls[0];
        expect(payload.type).toBe("trajectory.checkpoint");
        expect(payload.checkpoint.id).toBe("cp1");
        expect(payload.checkpoint.agentId).toBe("a");
        expect(payload.checkpoint.metadata).toEqual({ phase: "active" });
      });

      it("responds {ok: false} when no connection", async () => {
        const nullHandler = createCommandHandler(null, "swarm:test", registeredAgents);
        await nullHandler({ action: "trajectory-checkpoint", checkpoint: {} }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
      });
    });

    // ── State ─────────────────────────────────────────────────────────────

    describe("state", () => {
      it("calls connection.updateState for sidecar agent (no agentId)", async () => {
        await handler({ action: "state", state: "idle" }, mockClient);
        expect(mockConnection.updateState).toHaveBeenCalledWith("idle");
      });

      it("calls connection.updateMetadata when metadata provided", async () => {
        await handler({ action: "state", state: "idle", metadata: { lastStopReason: "end_turn" } }, mockClient);
        expect(mockConnection.updateState).toHaveBeenCalledWith("idle");
        expect(mockConnection.updateMetadata).toHaveBeenCalledWith({ lastStopReason: "end_turn" });
      });

      it("tracks state for child agent in registeredAgents", async () => {
        registeredAgents.set("gsd-exec", { name: "exec", role: "executor", metadata: {} });
        await handler({ action: "state", state: "idle", agentId: "gsd-exec" }, mockClient);
        expect(registeredAgents.get("gsd-exec").lastState).toBe("idle");
      });

      it("responds {ok: true} even if updateState fails", async () => {
        mockConnection.updateState.mockRejectedValueOnce(new Error("fail"));
        await handler({ action: "state", state: "idle" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
      });
    });

    // ── Ping ──────────────────────────────────────────────────────────────

    describe("ping", () => {
      it("responds with {ok: true, pid}", async () => {
        await handler({ action: "ping" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
        expect(written.pid).toBe(process.pid);
      });
    });

    // ── Unknown ───────────────────────────────────────────────────────────

    describe("unknown action", () => {
      it("responds with error", async () => {
        await handler({ action: "nope" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
        expect(written.error).toContain("Unknown action");
      });
    });

    // ── setConnection ─────────────────────────────────────────────────────

    describe("setConnection", () => {
      it("updates the connection reference", async () => {
        const newConn = {
          send: vi.fn().mockResolvedValue(undefined),
          spawn: vi.fn().mockResolvedValue(undefined),
          updateState: vi.fn(),
          updateMetadata: vi.fn(),
          callExtension: vi.fn(),
        };
        handler.setConnection(newConn);
        await handler({ action: "emit", event: { type: "x" } }, mockClient);
        expect(newConn.send).toHaveBeenCalled();
        expect(mockConnection.send).not.toHaveBeenCalled();
      });
    });
  });
});
