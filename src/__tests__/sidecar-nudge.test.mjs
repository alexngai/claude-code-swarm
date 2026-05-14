/**
 * Tests for dispatch thread nudge commands on the sidecar command handler.
 *
 * Covers Phase 7 of dispatch-inbox-threads:
 * - nudge command stores nudge state
 * - check-nudge returns and clears pending nudges
 * - Multiple nudges accumulate independently
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createCommandHandler, respond } from "../sidecar-server.mjs";

function createTestHandler() {
  const registeredAgents = new Map();
  return createCommandHandler(null, "swarm:test", registeredAgents, {
    transportMode: "websocket",
  });
}

function createFakeClient() {
  let lastResponse = null;
  return {
    write(data) {
      try {
        lastResponse = JSON.parse(data.replace(/\n$/, ""));
      } catch {
        lastResponse = data;
      }
    },
    writable: true,
    getResponse() {
      return lastResponse;
    },
  };
}

describe("sidecar nudge commands", () => {
  let handler;

  beforeEach(() => {
    handler = createTestHandler();
  });

  it("check-nudge returns empty array when no nudges pending", async () => {
    const client = createFakeClient();
    await handler({ action: "check-nudge" }, client);

    const resp = client.getResponse();
    expect(resp.ok).toBe(true);
    expect(resp.nudges).toEqual([]);
  });

  it("nudge stores state, check-nudge returns and clears it", async () => {
    const fakeClient = { write: () => {}, writable: true };

    // Store a nudge
    await handler(
      { action: "nudge", dispatch_id: "d1", conversation_id: "conv-d1" },
      fakeClient,
    );

    // Check nudge should return it
    const client = createFakeClient();
    await handler({ action: "check-nudge" }, client);

    const resp = client.getResponse();
    expect(resp.ok).toBe(true);
    expect(resp.nudges).toHaveLength(1);
    expect(resp.nudges[0]).toEqual({
      dispatch_id: "d1",
      conversation_id: "conv-d1",
    });

    // Second check should be empty (cleared)
    const client2 = createFakeClient();
    await handler({ action: "check-nudge" }, client2);

    const resp2 = client2.getResponse();
    expect(resp2.nudges).toEqual([]);
  });

  it("accumulates multiple nudges for different dispatches", async () => {
    const fakeClient = { write: () => {}, writable: true };

    await handler(
      { action: "nudge", dispatch_id: "d1", conversation_id: "conv-d1" },
      fakeClient,
    );
    await handler(
      { action: "nudge", dispatch_id: "d2", conversation_id: "conv-d2" },
      fakeClient,
    );

    const client = createFakeClient();
    await handler({ action: "check-nudge" }, client);

    const resp = client.getResponse();
    expect(resp.nudges).toHaveLength(2);
    const ids = resp.nudges.map((n) => n.dispatch_id).sort();
    expect(ids).toEqual(["d1", "d2"]);
  });

  it("overwrites nudge for same dispatch_id (latest wins)", async () => {
    const fakeClient = { write: () => {}, writable: true };

    await handler(
      { action: "nudge", dispatch_id: "d1", conversation_id: "conv-old" },
      fakeClient,
    );
    await handler(
      { action: "nudge", dispatch_id: "d1", conversation_id: "conv-new" },
      fakeClient,
    );

    const client = createFakeClient();
    await handler({ action: "check-nudge" }, client);

    const resp = client.getResponse();
    expect(resp.nudges).toHaveLength(1);
    expect(resp.nudges[0].conversation_id).toBe("conv-new");
  });

  it("ignores nudge with no dispatch_id", async () => {
    const fakeClient = { write: () => {}, writable: true };

    await handler(
      { action: "nudge", conversation_id: "conv-x" },
      fakeClient,
    );

    const client = createFakeClient();
    await handler({ action: "check-nudge" }, client);

    const resp = client.getResponse();
    expect(resp.nudges).toEqual([]);
  });
});
