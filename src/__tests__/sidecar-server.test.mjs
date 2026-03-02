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
        updateState: vi.fn().mockResolvedValue(undefined),
        callExtension: vi.fn().mockResolvedValue(undefined),
      };
      mockClient = { write: vi.fn() };
      registeredAgents = new Set();
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

    describe("register", () => {
      it("sends swarm.agent.registered event", async () => {
        await handler({
          action: "register",
          agent: { agentId: "a-1", name: "a", role: "dev", parent: "root", scopes: ["s"], metadata: {} },
        }, mockClient);
        const [, payload] = mockConnection.send.mock.calls[0];
        expect(payload.type).toBe("swarm.agent.registered");
        expect(payload.agentId).toBe("a-1");
      });

      it("adds agentId to registeredAgents", async () => {
        await handler({
          action: "register",
          agent: { agentId: "a-1", name: "a", role: "dev", parent: "root", scopes: ["s"], metadata: {} },
        }, mockClient);
        expect(registeredAgents.has("a-1")).toBe(true);
      });
    });

    describe("unregister", () => {
      it("sends swarm.agent.unregistered event", async () => {
        registeredAgents.add("a-1");
        await handler({ action: "unregister", agentId: "a-1", reason: "done" }, mockClient);
        const [, payload] = mockConnection.send.mock.calls[0];
        expect(payload.type).toBe("swarm.agent.unregistered");
      });

      it("removes agentId from registeredAgents", async () => {
        registeredAgents.add("a-1");
        await handler({ action: "unregister", agentId: "a-1" }, mockClient);
        expect(registeredAgents.has("a-1")).toBe(false);
      });

      it("uses default reason when not provided", async () => {
        await handler({ action: "unregister", agentId: "a-1" }, mockClient);
        const [, payload] = mockConnection.send.mock.calls[0];
        expect(payload.reason).toBe("task completed");
      });
    });

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

      it("falls back to broadcast when callExtension throws", async () => {
        mockConnection.callExtension.mockRejectedValueOnce(new Error("not supported"));
        const cp = { id: "cp1", agentId: "a", sessionId: "s", label: "l", metadata: { phase: "active" } };
        await handler({ action: "trajectory-checkpoint", checkpoint: cp }, mockClient);
        expect(mockConnection.send).toHaveBeenCalled();
        const [, payload] = mockConnection.send.mock.calls[0];
        expect(payload.type).toBe("swarm.sessionlog.sync");
      });

      it("responds {ok: false} when no connection", async () => {
        const nullHandler = createCommandHandler(null, "swarm:test", registeredAgents);
        await nullHandler({ action: "trajectory-checkpoint", checkpoint: {} }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
      });
    });

    describe("state", () => {
      it("calls connection.updateState", async () => {
        await handler({ action: "state", state: "idle" }, mockClient);
        expect(mockConnection.updateState).toHaveBeenCalledWith("idle");
      });

      it("responds {ok: true} even if updateState fails", async () => {
        mockConnection.updateState.mockRejectedValueOnce(new Error("fail"));
        await handler({ action: "state", state: "idle" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
      });
    });

    describe("ping", () => {
      it("responds with {ok: true, pid}", async () => {
        await handler({ action: "ping" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(true);
        expect(written.pid).toBe(process.pid);
      });
    });

    describe("unknown action", () => {
      it("responds with error", async () => {
        await handler({ action: "nope" }, mockClient);
        const written = JSON.parse(mockClient.write.mock.calls[0][0]);
        expect(written.ok).toBe(false);
        expect(written.error).toContain("Unknown action");
      });
    });

    describe("setConnection", () => {
      it("updates the connection reference", async () => {
        const newConn = { send: vi.fn().mockResolvedValue(undefined), updateState: vi.fn(), callExtension: vi.fn() };
        handler.setConnection(newConn);
        await handler({ action: "emit", event: { type: "x" } }, mockClient);
        expect(newConn.send).toHaveBeenCalled();
        expect(mockConnection.send).not.toHaveBeenCalled();
      });
    });
  });
});
