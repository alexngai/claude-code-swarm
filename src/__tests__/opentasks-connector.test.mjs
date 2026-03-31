import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOpenTasksHandler } from "../opentasks-connector.mjs";

// ── Mock factories ──────────────────────────────────────────────────────────

const MOCK_METHODS = {
  QUERY_REQUEST: "opentasks/query.request",
  LINK_REQUEST: "opentasks/link.request",
  ANNOTATE_REQUEST: "opentasks/annotate.request",
  TASK_REQUEST: "opentasks/task.request",
};

function createMockConnection() {
  const handlers = new Map();
  return {
    onNotification: vi.fn((method, handler) => {
      handlers.set(method, handler);
    }),
    sendNotification: vi.fn(),
    // Test helper: fire a notification as if the hub sent it
    _fireNotification(method, params) {
      const handler = handlers.get(method);
      if (handler) return handler(params);
    },
    _handlers: handlers,
  };
}

function createMockOpentasks() {
  const connector = {
    handleNotification: vi.fn(),
  };
  return {
    createClient: vi.fn(() => ({ /* mock client */ })),
    createMAPConnector: vi.fn(() => connector),
    MAP_CONNECTOR_METHODS: { ...MOCK_METHODS },
    _connector: connector,
  };
}

function createMockOpentasksClient(socketPath = "/tmp/opentasks/daemon.sock") {
  return {
    findSocketPath: vi.fn(() => socketPath),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerOpenTasksHandler", () => {
  let mockConn;
  let mockOpentasks;
  let mockOtClient;

  beforeEach(() => {
    mockConn = createMockConnection();
    mockOpentasks = createMockOpentasks();
    mockOtClient = createMockOpentasksClient();
  });

  const callRegister = (connOverride, optsOverride = {}) =>
    registerOpenTasksHandler(connOverride ?? mockConn, {
      scope: "swarm:test",
      importOpentasks: async () => mockOpentasks,
      importOpentasksClient: async () => mockOtClient,
      ...optsOverride,
    });

  it("creates a client with the socket path from findSocketPath", async () => {
    await callRegister();

    expect(mockOtClient.findSocketPath).toHaveBeenCalled();
    expect(mockOpentasks.createClient).toHaveBeenCalledWith({
      socketPath: "/tmp/opentasks/daemon.sock",
      autoConnect: true,
    });
  });

  it("creates a MAP connector with the client and a send function", async () => {
    await callRegister();

    expect(mockOpentasks.createMAPConnector).toHaveBeenCalledTimes(1);
    const callArgs = mockOpentasks.createMAPConnector.mock.calls[0][0];

    // Should pass the client returned by createClient
    expect(callArgs.client).toBeDefined();
    // Should pass a send function
    expect(typeof callArgs.send).toBe("function");
    // Should pass agentId derived from scope
    expect(callArgs.agentId).toBe("swarm:test-sidecar");
  });

  it("registers onNotification for all 4 request methods", async () => {
    await callRegister();

    expect(mockConn.onNotification).toHaveBeenCalledTimes(4);

    const registeredMethods = mockConn.onNotification.mock.calls.map((c) => c[0]);
    expect(registeredMethods).toContain(MOCK_METHODS.QUERY_REQUEST);
    expect(registeredMethods).toContain(MOCK_METHODS.LINK_REQUEST);
    expect(registeredMethods).toContain(MOCK_METHODS.ANNOTATE_REQUEST);
    expect(registeredMethods).toContain(MOCK_METHODS.TASK_REQUEST);
  });

  it("forwards notifications to connector.handleNotification", async () => {
    await callRegister();

    const params = { request_id: "req-1", query: "status:open" };
    await mockConn._fireNotification(MOCK_METHODS.QUERY_REQUEST, params);

    expect(mockOpentasks._connector.handleNotification).toHaveBeenCalledWith(
      MOCK_METHODS.QUERY_REQUEST,
      params,
    );
  });

  it("passes empty object when notification params are missing", async () => {
    await callRegister();

    await mockConn._fireNotification(MOCK_METHODS.TASK_REQUEST, undefined);

    expect(mockOpentasks._connector.handleNotification).toHaveBeenCalledWith(
      MOCK_METHODS.TASK_REQUEST,
      {},
    );
  });

  it("calls the send function on the connector via sendNotification", async () => {
    await callRegister();

    // Get the send function that was passed to createMAPConnector
    const sendFn = mockOpentasks.createMAPConnector.mock.calls[0][0].send;
    sendFn("opentasks/query.response", { data: "result" });

    expect(mockConn.sendNotification).toHaveBeenCalledWith(
      "opentasks/query.response",
      { data: "result" },
    );
  });

  it("does not throw when sendNotification fails in the send callback", async () => {
    mockConn.sendNotification.mockImplementation(() => {
      throw new Error("connection closed");
    });

    await callRegister();

    const sendFn = mockOpentasks.createMAPConnector.mock.calls[0][0].send;
    // Should not throw
    expect(() => sendFn("method", {})).not.toThrow();
  });

  it("calls onActivity callback when a notification fires", async () => {
    const onActivity = vi.fn();
    await callRegister(undefined, { onActivity });

    await mockConn._fireNotification(MOCK_METHODS.LINK_REQUEST, { request_id: "r1" });

    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("does nothing when conn is null", async () => {
    // Should not throw
    await registerOpenTasksHandler(null, {
      scope: "swarm:test",
      importOpentasks: async () => mockOpentasks,
      importOpentasksClient: async () => mockOtClient,
    });

    expect(mockOpentasks.createClient).not.toHaveBeenCalled();
  });

  it("does nothing when conn lacks onNotification", async () => {
    await registerOpenTasksHandler({ sendNotification: vi.fn() }, {
      scope: "swarm:test",
      importOpentasks: async () => mockOpentasks,
      importOpentasksClient: async () => mockOtClient,
    });

    expect(mockOpentasks.createClient).not.toHaveBeenCalled();
  });

  it("does nothing when opentasks module is missing createMAPConnector", async () => {
    const brokenModule = { createClient: vi.fn() }; // no createMAPConnector

    await registerOpenTasksHandler(mockConn, {
      scope: "swarm:test",
      importOpentasks: async () => brokenModule,
      importOpentasksClient: async () => mockOtClient,
    });

    expect(mockConn.onNotification).not.toHaveBeenCalled();
  });

  it("does nothing when opentasks import throws", async () => {
    await registerOpenTasksHandler(mockConn, {
      scope: "swarm:test",
      importOpentasks: async () => { throw new Error("module not found"); },
      importOpentasksClient: async () => mockOtClient,
    });

    expect(mockConn.onNotification).not.toHaveBeenCalled();
  });

  it("uses custom socket path from findSocketPath", async () => {
    const customClient = createMockOpentasksClient("/custom/path/daemon.sock");

    await callRegister(undefined, {
      importOpentasksClient: async () => customClient,
    });

    expect(mockOpentasks.createClient).toHaveBeenCalledWith({
      socketPath: "/custom/path/daemon.sock",
      autoConnect: true,
    });
  });
});
