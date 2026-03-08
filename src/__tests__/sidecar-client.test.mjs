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

  describe("isSidecarAlive with custom pidPath", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });
    afterEach(() => {
      cleanupTmpDir(tmpDir);
    });

    it("returns true when PID file contains current process PID", () => {
      const pidPath = path.join(tmpDir, "test.pid");
      fs.writeFileSync(pidPath, String(process.pid));
      expect(isSidecarAlive(pidPath)).toBe(true);
    });

    it("returns false when PID file contains non-existent PID", () => {
      const pidPath = path.join(tmpDir, "test.pid");
      fs.writeFileSync(pidPath, "999999999");
      expect(isSidecarAlive(pidPath)).toBe(false);
    });

    it("returns false when custom pidPath does not exist", () => {
      expect(isSidecarAlive(path.join(tmpDir, "nope.pid"))).toBe(false);
    });
  });

  describe("killSidecar", () => {
    it("does not throw when PID file is missing", () => {
      expect(() => killSidecar()).not.toThrow();
    });

    it("does not throw when sessionId is null (legacy paths)", () => {
      expect(() => killSidecar(null)).not.toThrow();
    });

    it("does not throw when sessionId is provided but no PID file exists", () => {
      expect(() => killSidecar("nonexistent-session")).not.toThrow();
    });
  });
});
