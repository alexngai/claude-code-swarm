import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import path from "path";
import fs from "fs";
import { findSocketPath, rpcRequest, isDaemonAlive, pushSyncEvent, createTask, updateTask } from "../opentasks-client.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

// ── Helper: JSON-RPC 2.0 server ─────────────────────────────────────────────

function createRpcServer(socketPath, handler) {
  const connections = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    let buffer = "";
    conn.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          const result = handler(req.method, req.params, req.id);
          if (result === null) {
            conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "not found" } }) + "\n");
          } else {
            conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: result ?? {} }) + "\n");
          }
        } catch {
          // ignore parse errors
        }
      }
    });
  });
  server.__testConns = connections;
  return server;
}

async function listenServer(server, socketPath) {
  await new Promise((resolve) => server.listen(socketPath, resolve));
}

async function closeServer(server) {
  if (!server) return;
  for (const conn of server.__testConns || []) {
    conn.destroy();
  }
  await new Promise((r) => server.close(r));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("opentasks-client", () => {
  describe("findSocketPath", () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-find-");
      originalCwd = process.cwd();
      process.chdir(tmpDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      cleanupTmpDir(tmpDir);
    });

    it("returns swarmkit default when no socket files exist", () => {
      const result = findSocketPath();
      expect(result).toBe(path.join(".swarm", "opentasks", "daemon.sock"));
    });

    it("returns .swarm/opentasks/daemon.sock when it exists (first priority)", () => {
      const sockDir = path.join(tmpDir, ".swarm", "opentasks");
      fs.mkdirSync(sockDir, { recursive: true });
      fs.writeFileSync(path.join(sockDir, "daemon.sock"), "");

      const result = findSocketPath();
      expect(result).toBe(path.join(".swarm", "opentasks", "daemon.sock"));
    });

    it("returns .opentasks/daemon.sock when swarmkit path does not exist", () => {
      const sockDir = path.join(tmpDir, ".opentasks");
      fs.mkdirSync(sockDir, { recursive: true });
      fs.writeFileSync(path.join(sockDir, "daemon.sock"), "");

      const result = findSocketPath();
      expect(result).toBe(path.join(".opentasks", "daemon.sock"));
    });

    it("returns .git/opentasks/daemon.sock as third priority", () => {
      const sockDir = path.join(tmpDir, ".git", "opentasks");
      fs.mkdirSync(sockDir, { recursive: true });
      fs.writeFileSync(path.join(sockDir, "daemon.sock"), "");

      const result = findSocketPath();
      expect(result).toBe(path.join(".git", "opentasks", "daemon.sock"));
    });

    it("prefers swarmkit path over .opentasks when both exist", () => {
      fs.mkdirSync(path.join(tmpDir, ".swarm", "opentasks"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".swarm", "opentasks", "daemon.sock"), "");
      fs.mkdirSync(path.join(tmpDir, ".opentasks"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".opentasks", "daemon.sock"), "");

      const result = findSocketPath();
      expect(result).toBe(path.join(".swarm", "opentasks", "daemon.sock"));
    });
  });

  describe("rpcRequest", () => {
    let tmpDir;
    let socketPath;
    let server;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-rpc-");
      socketPath = path.join(tmpDir, "test.sock");
    });

    afterEach(async () => {
      await closeServer(server);
      server = null;
      cleanupTmpDir(tmpDir);
    });

    it("returns result from successful RPC response", async () => {
      server = createRpcServer(socketPath, (method) => {
        if (method === "test.echo") return { value: "hello" };
        return {};
      });
      await listenServer(server, socketPath);

      const result = await rpcRequest("test.echo", {}, socketPath);
      expect(result).toEqual({ value: "hello" });
    });

    it("returns {} when server returns result without explicit value", async () => {
      server = createRpcServer(socketPath, () => undefined);
      await listenServer(server, socketPath);

      const result = await rpcRequest("ping", {}, socketPath);
      expect(result).toEqual({});
    });

    it("returns null when socket does not exist", async () => {
      const result = await rpcRequest("ping", {}, path.join(tmpDir, "nope.sock"));
      expect(result).toBeNull();
    });

    it("returns null when server responds with JSON-RPC error", async () => {
      server = createRpcServer(socketPath, () => null); // handler returns null → error response
      await listenServer(server, socketPath);

      const result = await rpcRequest("bad.method", {}, socketPath);
      expect(result).toBeNull();
    });

    it("returns null on timeout", async () => {
      // Server that connects but never responds
      const conns = [];
      server = net.createServer((conn) => { conns.push(conn); });
      server.__testConns = conns;
      await listenServer(server, socketPath);

      const result = await rpcRequest("ping", {}, socketPath, 200);
      expect(result).toBeNull();
    }, 5000);

    it("sends correct JSON-RPC 2.0 format", async () => {
      let receivedRequest = null;
      server = createRpcServer(socketPath, (method, params, id) => {
        receivedRequest = { method, params, id };
        return { ok: true };
      });
      await listenServer(server, socketPath);

      await rpcRequest("graph.update", { uri: "test://1" }, socketPath);
      // Wait briefly for server to process
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedRequest).not.toBeNull();
      expect(receivedRequest.method).toBe("graph.update");
      expect(receivedRequest.params).toEqual({ uri: "test://1" });
      expect(typeof receivedRequest.id).toBe("string");
    });
  });

  describe("isDaemonAlive", () => {
    let tmpDir;
    let socketPath;
    let server;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-alive-");
      socketPath = path.join(tmpDir, "test.sock");
    });

    afterEach(async () => {
      await closeServer(server);
      server = null;
      cleanupTmpDir(tmpDir);
    });

    it("returns true when daemon responds to ping", async () => {
      server = createRpcServer(socketPath, () => ({ pong: true }));
      await listenServer(server, socketPath);

      const result = await isDaemonAlive(socketPath);
      expect(result).toBe(true);
    });

    it("returns false when socket does not exist", async () => {
      const result = await isDaemonAlive(path.join(tmpDir, "nope.sock"));
      expect(result).toBe(false);
    });
  });

  describe("pushSyncEvent", () => {
    let tmpDir;
    let socketPath;
    let server;
    let rpcCalls;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-sync-");
      socketPath = path.join(tmpDir, "test.sock");
      rpcCalls = [];
    });

    afterEach(async () => {
      await closeServer(server);
      server = null;
      cleanupTmpDir(tmpDir);
    });

    function startSyncServer(updateResult = {}) {
      server = createRpcServer(socketPath, (method, params) => {
        rpcCalls.push({ method, params });
        return updateResult;
      });
      return listenServer(server, socketPath);
    }

    it("task.sync with id sends graph.update with correct params", async () => {
      await startSyncServer({ ok: true });

      const result = await pushSyncEvent(socketPath, {
        type: "task.sync",
        id: "task-1",
        uri: "claude://team/task-1",
        status: "open",
        subject: "Fix bug",
        source: "claude-code",
      });

      expect(result).toBe(true);
      expect(rpcCalls[0].method).toBe("graph.update");
      expect(rpcCalls[0].params.id).toBe("task-1");
      expect(rpcCalls[0].params.status).toBe("open");
      expect(rpcCalls[0].params.title).toBe("Fix bug");
      expect(rpcCalls[0].params.metadata.source).toBe("claude-code");
    });

    it("task.sync without id sends graph.create directly", async () => {
      await startSyncServer({ created: true });

      const result = await pushSyncEvent(socketPath, {
        type: "task.sync",
        uri: "claude://team/task-1",
        status: "open",
        subject: "Fix bug",
        source: "claude-code",
      });

      expect(result).toBe(true);
      expect(rpcCalls[0].method).toBe("graph.create");
      expect(rpcCalls[0].params.type).toBe("task");
      expect(rpcCalls[0].params.uri).toBe("claude://team/task-1");
      expect(rpcCalls[0].params.title).toBe("Fix bug");
    });

    it("task.sync falls back to graph.create when update returns null", async () => {
      // Server returns null on first call (graph.update), then success on second (graph.create)
      let callCount = 0;
      server = createRpcServer(socketPath, (method, params) => {
        rpcCalls.push({ method, params });
        callCount++;
        if (callCount === 1) return null; // update fails → error response
        return { created: true };
      });
      await listenServer(server, socketPath);

      const result = await pushSyncEvent(socketPath, {
        type: "task.sync",
        id: "existing-task",
        uri: "claude://team/new-task",
        status: "open",
        subject: "New task",
        source: "claude-code",
      });

      expect(result).toBe(true);
      expect(rpcCalls.length).toBe(2);
      expect(rpcCalls[0].method).toBe("graph.update");
      expect(rpcCalls[0].params.id).toBe("existing-task");
      expect(rpcCalls[1].method).toBe("graph.create");
      expect(rpcCalls[1].params.type).toBe("task");
      expect(rpcCalls[1].params.uri).toBe("claude://team/new-task");
    });

    it("task.claimed sends graph.update with in_progress and assignee", async () => {
      await startSyncServer({ ok: true });

      await pushSyncEvent(socketPath, {
        type: "task.claimed",
        id: "task-2",
        agent: "worker-1",
        source: "claude-code",
      });

      expect(rpcCalls[0].method).toBe("graph.update");
      expect(rpcCalls[0].params.id).toBe("task-2");
      expect(rpcCalls[0].params.status).toBe("in_progress");
      expect(rpcCalls[0].params.assignee).toBe("worker-1");
    });

    it("task.claimed returns false when id is missing", async () => {
      await startSyncServer({ ok: true });

      const result = await pushSyncEvent(socketPath, {
        type: "task.claimed",
        agent: "worker-1",
        source: "claude-code",
      });

      expect(result).toBe(false);
      expect(rpcCalls.length).toBe(0);
    });

    it("task.unblocked sends graph.update with open status", async () => {
      await startSyncServer({ ok: true });

      await pushSyncEvent(socketPath, {
        type: "task.unblocked",
        id: "task-3",
        unblockedBy: "task-1",
        source: "claude-code",
      });

      expect(rpcCalls[0].method).toBe("graph.update");
      expect(rpcCalls[0].params.id).toBe("task-3");
      expect(rpcCalls[0].params.status).toBe("open");
      expect(rpcCalls[0].params.metadata.unblockedBy).toBe("task-1");
    });

    it("task.unblocked returns false when id is missing", async () => {
      await startSyncServer({ ok: true });

      const result = await pushSyncEvent(socketPath, {
        type: "task.unblocked",
        unblockedBy: "task-1",
        source: "claude-code",
      });

      expect(result).toBe(false);
      expect(rpcCalls.length).toBe(0);
    });

    it("task.linked sends tools.link with fromId, toId, type", async () => {
      await startSyncServer({ ok: true });

      await pushSyncEvent(socketPath, {
        type: "task.linked",
        from: "task://a",
        to: "task://b",
        linkType: "blocks",
        source: "opentasks",
      });

      expect(rpcCalls[0].method).toBe("tools.link");
      expect(rpcCalls[0].params.fromId).toBe("task://a");
      expect(rpcCalls[0].params.toId).toBe("task://b");
      expect(rpcCalls[0].params.type).toBe("blocks");
    });

    it("defaults linkType to 'related' when not specified", async () => {
      await startSyncServer({ ok: true });

      await pushSyncEvent(socketPath, {
        type: "task.linked",
        from: "task://a",
        to: "task://b",
        source: "opentasks",
      });

      expect(rpcCalls[0].params.type).toBe("related");
    });

    it("returns false for unknown event type", async () => {
      await startSyncServer({ ok: true });

      const result = await pushSyncEvent(socketPath, {
        type: "unknown.event",
        uri: "test://1",
      });

      expect(result).toBe(false);
      expect(rpcCalls.length).toBe(0);
    });

    it("returns true for task.sync even on socket error (best-effort)", async () => {
      const result = await pushSyncEvent(path.join(tmpDir, "nope.sock"), {
        type: "task.sync",
        uri: "test://1",
        source: "test",
      });

      // pushSyncEvent catches errors and returns true for task.sync (best-effort success)
      expect(result).toBe(true);
    });
  });

  describe("createTask", () => {
    let tmpDir;
    let socketPath;
    let server;
    let rpcCalls;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-create-");
      socketPath = path.join(tmpDir, "test.sock");
      rpcCalls = [];
    });

    afterEach(async () => {
      await closeServer(server);
      server = null;
      cleanupTmpDir(tmpDir);
    });

    it("sends graph.create with type 'task' and provided params", async () => {
      server = createRpcServer(socketPath, (method, params) => {
        rpcCalls.push({ method, params });
        return { id: "new-task-1" };
      });
      await listenServer(server, socketPath);

      const result = await createTask(socketPath, {
        title: "Fix bug",
        status: "open",
        assignee: "worker-1",
        metadata: { source: "test" },
      });

      expect(result).toEqual({ id: "new-task-1" });
      expect(rpcCalls[0].method).toBe("graph.create");
      expect(rpcCalls[0].params.type).toBe("task");
      expect(rpcCalls[0].params.title).toBe("Fix bug");
      expect(rpcCalls[0].params.status).toBe("open");
      expect(rpcCalls[0].params.assignee).toBe("worker-1");
    });

    it("returns null on socket error", async () => {
      const result = await createTask(path.join(tmpDir, "nope.sock"), {
        title: "Test",
      });
      expect(result).toBeNull();
    });
  });

  describe("updateTask", () => {
    let tmpDir;
    let socketPath;
    let server;
    let rpcCalls;

    beforeEach(() => {
      tmpDir = makeTmpDir("opentasks-update-");
      socketPath = path.join(tmpDir, "test.sock");
      rpcCalls = [];
    });

    afterEach(async () => {
      await closeServer(server);
      server = null;
      cleanupTmpDir(tmpDir);
    });

    it("sends graph.update with id and flat update fields", async () => {
      server = createRpcServer(socketPath, (method, params) => {
        rpcCalls.push({ method, params });
        return { id: "task-1", status: "closed" };
      });
      await listenServer(server, socketPath);

      const result = await updateTask(socketPath, "task-1", {
        status: "closed",
        metadata: { completedBy: "worker-1" },
      });

      expect(result).toEqual({ id: "task-1", status: "closed" });
      expect(rpcCalls[0].method).toBe("graph.update");
      expect(rpcCalls[0].params.id).toBe("task-1");
      expect(rpcCalls[0].params.status).toBe("closed");
      expect(rpcCalls[0].params.metadata.completedBy).toBe("worker-1");
    });

    it("returns null on socket error", async () => {
      const result = await updateTask(path.join(tmpDir, "nope.sock"), "task-1", {
        status: "closed",
      });
      expect(result).toBeNull();
    });
  });
});
