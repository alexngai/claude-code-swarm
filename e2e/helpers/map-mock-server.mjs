/**
 * map-mock-server.mjs — Minimal mock MAP WebSocket server for e2e tests
 *
 * Records all received messages and handles basic MAP protocol handshakes
 * so the sidecar doesn't crash on connection.
 */

import { WebSocketServer } from "ws";

export class MockMapServer {
  constructor() {
    this.wss = null;
    this.port = 0;
    this.receivedMessages = [];
    this.connections = [];
  }

  /**
   * Start the mock server on a random available port.
   * Returns a promise that resolves with the assigned port.
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
            // Invalid JSON, record raw
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
   * Handle incoming MAP protocol messages with minimal responses.
   */
  _handleMessage(ws, msg) {
    // JSON-RPC style: respond with result if there's an id
    if (msg.id !== undefined) {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { ok: true, agentId: msg.params?.name || "mock-agent" },
        })
      );
      return;
    }

    // MAP connect message
    if (msg.type === "connect" || msg.method === "connect") {
      ws.send(
        JSON.stringify({
          type: "connected",
          agentId: msg.name || "mock-agent",
        })
      );
    }
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

  clearMessages() {
    this.receivedMessages = [];
  }

  /**
   * Stop the mock server and close all connections.
   */
  stop() {
    return new Promise((resolve) => {
      for (const ws of this.connections) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
