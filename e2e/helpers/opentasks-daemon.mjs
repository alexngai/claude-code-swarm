/**
 * Test helper: minimal opentasks daemon for e2e tests
 *
 * Creates a JSON-RPC 2.0 server on a Unix socket that implements the
 * subset of opentasks daemon methods used by opentasks-client.mjs:
 *   - ping → { pong: true }
 *   - graph.create → stores node, returns { id, ...params }
 *   - graph.update → updates stored node, returns updated node
 *   - tools.link → stores edge, returns { ok: true }
 *
 * Uses in-memory storage. No persistence, no providers, no flush.
 */

import net from "net";
import fs from "fs";
import { randomUUID } from "crypto";

/**
 * Start a minimal opentasks daemon on a Unix socket.
 * Returns { socketPath, stop(), nodes, edges }.
 */
export function startTestDaemon(socketPath) {
  const nodes = new Map();
  const edges = [];
  let server;

  return new Promise((resolve, reject) => {
    // Remove stale socket
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

    server = net.createServer((conn) => {
      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line);
            const result = handleRequest(req, nodes, edges);
            conn.write(JSON.stringify(result) + "\n");
          } catch (err) {
            conn.write(JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error", data: err.message },
            }) + "\n");
          }
        }
      });
    });

    server.on("error", reject);

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        nodes,
        edges,
        stop: () => new Promise((res) => {
          server.close(() => {
            try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
            res();
          });
          // Force close connections
          server.unref();
        }),
      });
    });
  });
}

function handleRequest(req, nodes, edges) {
  const { id, method, params } = req;

  switch (method) {
    case "ping":
      return { jsonrpc: "2.0", id, result: { pong: true } };

    case "graph.create": {
      const nodeId = randomUUID();
      const node = {
        id: nodeId,
        type: params?.type || "task",
        title: params?.title || "",
        status: params?.status || "open",
        assignee: params?.assignee || null,
        uri: params?.uri || null,
        metadata: params?.metadata || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nodes.set(nodeId, node);
      return { jsonrpc: "2.0", id, result: node };
    }

    case "graph.update": {
      const nodeId = params?.id;
      if (!nodeId || !nodes.has(nodeId)) {
        return {
          jsonrpc: "2.0", id,
          error: { code: -32602, message: `Node not found: ${nodeId}` },
        };
      }
      const existing = nodes.get(nodeId);
      const updated = {
        ...existing,
        ...(params.status !== undefined && { status: params.status }),
        ...(params.title !== undefined && { title: params.title }),
        ...(params.assignee !== undefined && { assignee: params.assignee }),
        ...(params.metadata !== undefined && { metadata: { ...existing.metadata, ...params.metadata } }),
        updatedAt: new Date().toISOString(),
      };
      nodes.set(nodeId, updated);
      return { jsonrpc: "2.0", id, result: updated };
    }

    case "graph.query": {
      const allNodes = Array.from(nodes.values());
      const filtered = params?.type
        ? allNodes.filter((n) => n.type === params.type)
        : allNodes;
      return { jsonrpc: "2.0", id, result: filtered };
    }

    case "tools.link": {
      const edge = {
        fromId: params?.fromId,
        toId: params?.toId,
        type: params?.type || "related",
        metadata: params?.metadata || {},
      };
      edges.push(edge);
      return { jsonrpc: "2.0", id, result: { ok: true } };
    }

    case "shutdown":
      return { jsonrpc: "2.0", id, result: { ok: true } };

    default:
      return {
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
