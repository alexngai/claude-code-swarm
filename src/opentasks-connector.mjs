/**
 * opentasks-connector.mjs — MAP connector registration for opentasks
 *
 * Extracted from map-sidecar.mjs for testability.
 * Registers notification handlers on a MAP connection so that when the hub
 * (or another agent) sends opentasks/*.request notifications, the connector
 * queries the local daemon and sends back opentasks/*.response.
 */

import { createLogger } from "./log.mjs";

const log = createLogger("opentasks-connector");

/**
 * Register opentasks notification handlers on a MAP connection.
 *
 * @param {object} conn - MAP connection with onNotification/sendNotification
 * @param {object} options
 * @param {string} options.scope - MAP scope (e.g. "swarm:gsd")
 * @param {() => void} [options.onActivity] - Called on each notification (for inactivity timer reset)
 * @param {() => Promise<object>} [options.importOpentasks] - Override for dynamic import("opentasks")
 * @param {() => Promise<object>} [options.importOpentasksClient] - Override for dynamic import of opentasks-client
 */
export async function registerOpenTasksHandler(conn, options = {}) {
  if (!conn || typeof conn.onNotification !== "function") return;

  const {
    scope = "swarm:default",
    onActivity,
    importOpentasks,
    importOpentasksClient,
  } = options;

  try {
    const opentasks = importOpentasks
      ? await importOpentasks()
      : await import("opentasks");

    if (!opentasks?.createMAPConnector || !opentasks?.createClient) {
      log.debug("opentasks MAP connector not available (missing exports)");
      return;
    }

    const { createMAPConnector, createClient, MAP_CONNECTOR_METHODS } = opentasks;

    const opentasksClient = importOpentasksClient
      ? await importOpentasksClient()
      : await import("./opentasks-client.mjs");

    const { findSocketPath } = opentasksClient;
    const socketPath = findSocketPath();
    const client = createClient({ socketPath, autoConnect: true });

    const connector = createMAPConnector({
      client,
      send: (method, params) => {
        try {
          conn.sendNotification(method, params);
        } catch {
          log.debug("failed to send opentasks response", { method });
        }
      },
      agentId: `${scope}-sidecar`,
    });

    // Subscribe to every `opentasks/*.request` method the opentasks package
    // exports. Iterating MAP_CONNECTOR_METHODS (rather than hardcoding a list)
    // means new request methods added upstream — e.g. graph.create.request,
    // graph.update.request — are wired up automatically.
    const requestMethods = Object.values(MAP_CONNECTOR_METHODS).filter(
      (m) => typeof m === "string" && m.endsWith(".request"),
    );

    for (const method of requestMethods) {
      conn.onNotification(method, async (params) => {
        log.debug("opentasks request received", { method, requestId: params?.request_id });
        if (onActivity) onActivity();
        connector.handleNotification(method, params || {});
      });
    }

    log.info("opentasks connector registered", { methods: requestMethods.length });
  } catch (err) {
    log.debug("opentasks connector not available", { error: err.message });
  }
}
