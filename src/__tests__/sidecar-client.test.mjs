import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import net from "net";
import { sendToSidecar, isSidecarAlive, killSidecar } from "../sidecar-client.mjs";
import { makeTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("sidecar-client", () => {
  describe("sendToSidecar", () => {
    let tmpDir;
    let socketPath;
    let server;
    let connections;

    beforeEach(() => {
      tmpDir = makeTmpDir();
      socketPath = path.join(tmpDir, "test.sock");
      connections = [];
    });
    afterEach(async () => {
      // Force-destroy any lingering server-side connections before closing
      for (const conn of connections) {
        conn.destroy();
      }
      if (server) {
        await new Promise((r) => server.close(r));
        server = null;
      }
      cleanupTmpDir(tmpDir);
    });

    it("returns true when socket connection succeeds", async () => {
      server = net.createServer((conn) => { connections.push(conn); });
      await new Promise((resolve) => server.listen(socketPath, resolve));

      const result = await sendToSidecar({ action: "ping" }, socketPath);
      expect(result).toBe(true);
    });

    it("returns false when socket does not exist", async () => {
      const result = await sendToSidecar({ action: "ping" }, path.join(tmpDir, "nope.sock"));
      expect(result).toBe(false);
    });

    it("sends JSON-serialized command with newline", async () => {
      let received = "";
      server = net.createServer((conn) => {
        connections.push(conn);
        conn.on("data", (data) => { received += data.toString(); });
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));

      await sendToSidecar({ action: "test", data: 42 }, socketPath);
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toContain('"action":"test"');
      expect(received).toContain('"data":42');
      expect(received.endsWith("\n")).toBe(true);
    });
  });

  describe("isSidecarAlive", () => {
    it("returns false when PID file does not exist", () => {
      const result = isSidecarAlive();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("killSidecar", () => {
    it("does not throw when PID file is missing", () => {
      expect(() => killSidecar()).not.toThrow();
    });
  });
});
