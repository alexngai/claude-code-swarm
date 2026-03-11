/**
 * map-mock-server.mjs — Protocol-compliant mock MAP WebSocket server for e2e tests
 *
 * Speaks enough of the MAP JSON-RPC protocol for the SDK's AgentConnection.connect()
 * to succeed: handles map/connect, map/agents/register, map/agents/spawn,
 * map/agents/unregister, map/agents/update, map/send, and trajectory/checkpoint.
 *
 * Also supports:
 * - Sending inbound messages to connected clients
 * - Configurable response delays for resilience testing
 * - Method-specific message tracking
 */

import { WebSocketServer } from "ws";

let _counter = 0;
function nextId() {
  return `mock-${++_counter}`;
}

export class MockMapServer {
  constructor() {
    this.wss = null;
    this.port = 0;
    this.connections = [];
    this.receivedMessages = [];
    this.responseDelayMs = 0;
    this.trajectorySupported = false;

    // Method-specific tracking
    this.spawnedAgents = [];
    this.sentMessages = [];
    this.callExtensions = [];
    this.stateUpdates = [];
  }

  /**
   * Start the mock server on a random available port.
   */
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: 0 }, () => {
        this.port = this.wss.address().port;
        resolve(this.port);
      });

      this.wss.on("connection", (ws) => {
        this.connections.push(ws);

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.receivedMessages.push({
              timestamp: Date.now(),
              data: msg,
            });
            this._handleMessage(ws, msg);
          } catch {
            this.receivedMessages.push({
              timestamp: Date.now(),
              raw: data.toString(),
            });
          }
        });

        ws.on("close", () => {
          this.connections = this.connections.filter((c) => c !== ws);
        });
      });

      this.wss.on("error", reject);
    });
  }

  /**
   * Handle incoming MAP protocol messages with method-specific responses.
   */
  async _handleMessage(ws, msg) {
    if (this.responseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.responseDelayMs));
    }

    const { id, method, params } = msg;

    // Non-RPC messages (no id) — legacy compat
    if (id === undefined) {
      if (msg.type === "connect" || msg.method === "connect") {
        ws.send(JSON.stringify({
          type: "connected",
          agentId: msg.name || "mock-agent",
        }));
      }
      return;
    }

    // JSON-RPC dispatch by method
    switch (method) {
      case "map/connect": {
        this._respond(ws, id, {
          sessionId: `session-${nextId()}`,
          capabilities: {},
          protocolVersion: "1.0",
        });
        break;
      }

      case "map/agents/register": {
        const agent = {
          id: params?.agentId || params?.name || nextId(),
          state: "idle",
          name: params?.name || "agent",
          role: params?.role || "agent",
        };
        this._respond(ws, id, { agent });
        break;
      }

      case "map/agents/spawn": {
        const agent = {
          id: params?.agentId || nextId(),
          state: "idle",
          name: params?.name || "spawned",
          role: params?.role || "agent",
        };
        this.spawnedAgents.push({ ...params, _timestamp: Date.now() });
        this._respond(ws, id, { agent });
        break;
      }

      case "map/agents/unregister": {
        this.callExtensions.push({
          method: "map/agents/unregister",
          params,
          _timestamp: Date.now(),
        });
        this._respond(ws, id, { ok: true });
        break;
      }

      case "map/agents/update": {
        this.stateUpdates.push({ ...params, _timestamp: Date.now() });
        this._respond(ws, id, { ok: true });
        break;
      }

      case "map/send": {
        this.sentMessages.push({ ...params, _timestamp: Date.now() });
        this._respond(ws, id, { messageId: nextId() });
        break;
      }

      case "trajectory/checkpoint": {
        if (this.trajectorySupported) {
          this._respond(ws, id, { ok: true });
        } else {
          this._respondError(ws, id, -32601, "Method not found: trajectory/checkpoint");
        }
        break;
      }

      default: {
        // Check if it's a callExtension-style method
        if (method) {
          this.callExtensions.push({ method, params, _timestamp: Date.now() });
          this._respond(ws, id, { ok: true });
        } else {
          this._respondError(ws, id, -32601, `Unknown method: ${method}`);
        }
      }
    }
  }

  _respond(ws, id, result) {
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch { /* client gone */ }
  }

  _respondError(ws, id, code, message) {
    try {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      }));
    } catch { /* client gone */ }
  }

  /**
   * Send a MAP message notification to all connected clients.
   * Simulates an external agent sending a message into the scope.
   */
  sendToAll(payload, meta = {}) {
    const notification = this._buildMessageNotification(payload, meta);
    for (const ws of this.connections) {
      try {
        ws.send(notification);
      } catch { /* ignore */ }
    }
  }

  /**
   * Send a MAP message notification to a specific client.
   */
  sendToClient(ws, payload, meta = {}) {
    try {
      ws.send(this._buildMessageNotification(payload, meta));
    } catch { /* ignore */ }
  }

  /**
   * Build a MAP message notification in the exact JSON-RPC 2.0 format
   * the SDK expects: no top-level `id` (notification, not request),
   * method "map/message", params.message with id/from/to/timestamp/payload/meta.
   */
  _buildMessageNotification(payload, meta = {}) {
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "map/message",
      params: {
        message: {
          id: nextId(),
          from: meta.from || "external-agent",
          to: meta.to || { scope: "default" },
          timestamp: new Date().toISOString(),
          payload,
          meta,
        },
      },
    });
  }

  /**
   * Set response delay for resilience testing.
   */
  setResponseDelay(ms) {
    this.responseDelayMs = ms;
  }

  /**
   * Get received messages, optionally filtered by event type.
   */
  getMessages(eventType = null) {
    if (!eventType) return this.receivedMessages;
    return this.receivedMessages.filter(
      (m) =>
        m.data?.type === eventType ||
        m.data?.event?.type === eventType ||
        m.data?.params?.type === eventType
    );
  }

  /**
   * Get received messages filtered by JSON-RPC method.
   */
  getByMethod(method) {
    return this.receivedMessages.filter((m) => m.data?.method === method);
  }

  clearMessages() {
    this.receivedMessages = [];
    this.spawnedAgents = [];
    this.sentMessages = [];
    this.callExtensions = [];
    this.stateUpdates = [];
  }

  /**
   * Stop the mock server and close all connections.
   */
  stop() {
    return new Promise((resolve) => {
      // Force-terminate all connections immediately to prevent
      // auto-reconnecting clients from keeping the server alive.
      for (const ws of this.connections) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
      this.connections = [];

      if (this.wss) {
        // Reject any new connections that arrive during shutdown
        this.wss.on("connection", (ws) => {
          try { ws.terminate(); } catch { /* ignore */ }
        });
        this.wss.close(() => resolve());
        // Safety timeout — resolve after 3s even if wss.close() hangs
        setTimeout(resolve, 3000);
      } else {
        resolve();
      }
    });
  }
}
