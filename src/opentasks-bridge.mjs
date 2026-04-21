/**
 * opentasks-bridge.mjs — Opentasks MAP event bridge for the sidecar
 *
 * Attaches opentasks' `createMAPEventBridge` to the local daemon's watch
 * stream so every graph change surfaces as a `task.*` / `context.*` MAP
 * event over the shared MAP connection. The bridge is kind-agnostic for
 * contexts — downstream consumers (e.g. OpenHive's hub) route by
 * `metadata.kind` to classify specs vs plain contexts.
 *
 * This is the "Option A" daemon-wired path — no explicit `bridge-*`
 * sidecar command is needed for contexts. For tasks, the existing
 * PostToolUse(TaskCreate) → `bridge-task-*` command chain remains the
 * active path (matches the filters in sidecar-server.mjs and avoids
 * double-emission when both hooks and the watcher fire for the same
 * change).
 *
 * Extracted from map-sidecar.mjs for testability.
 */

import { createLogger } from "./log.mjs";

const log = createLogger("opentasks-bridge");

/**
 * Start the opentasks MAP event bridge.
 *
 * Connects to the local opentasks daemon, subscribes to graph changes,
 * and forwards every event through the MAP event bridge so connected
 * observers (OpenHive hub, peer swarms) see them as standard MAP events.
 *
 * Safe to call when the daemon isn't running or when MAP connection is
 * absent — returns `null` and logs at debug level.
 *
 * @param {object} conn - MAP connection (AgentConnection or MeshPeer connection)
 * @param {object} options
 * @param {string} options.scope - MAP scope (e.g. "swarm:gsd")
 * @param {() => void} [options.onActivity] - Called on each bridged event
 * @param {() => Promise<object>} [options.importOpentasks] - Override for `await import("opentasks")`
 * @param {() => Promise<object>} [options.importOpentasksClient] - Override for `./opentasks-client.mjs` import
 * @returns {Promise<{ stop: () => Promise<void> } | null>}
 */
export async function startOpenTasksEventBridge(conn, options = {}) {
  if (!conn) return null;

  const {
    scope = "swarm:default",
    onActivity,
    importOpentasks,
    importOpentasksClient,
  } = options;

  let opentasks;
  try {
    opentasks = importOpentasks
      ? await importOpentasks()
      : await import("opentasks");
  } catch (err) {
    log.debug("opentasks package not available", { error: err.message });
    return null;
  }

  const { createMAPEventBridge, createIPCClient } = opentasks || {};
  if (!createMAPEventBridge || !createIPCClient) {
    log.debug("opentasks event-bridge exports missing");
    return null;
  }

  let socketPath;
  try {
    const opentasksClient = importOpentasksClient
      ? await importOpentasksClient()
      : await import("./opentasks-client.mjs");
    socketPath = opentasksClient.findSocketPath();
  } catch (err) {
    log.debug("could not resolve opentasks socket path", { error: err.message });
    return null;
  }

  const client = createIPCClient(socketPath);
  try {
    await client.connect();
  } catch (err) {
    log.debug("opentasks daemon not reachable, bridge disabled", {
      socketPath,
      error: err.message,
    });
    return null;
  }

  const bridge = createMAPEventBridge({
    connection: conn,
    scope,
    agentId: `${scope}-sidecar`,
    // Suppress bridge task.* events — the sidecar's existing
    // `bridge-task-*` command chain (driven by PostToolUse hooks) is the
    // canonical path for tasks. Emitting here too would duplicate every
    // task event. Contexts have no hook counterpart, so they only flow
    // via this watcher.
    filter: (type) => !type.startsWith("task."),
  });

  const offNotif = client.onNotification((method, params) => {
    if (method !== "watch.event") return;
    if (onActivity) onActivity();
    log.debug("watch.event received", {
      kind: params?.type,
      nodeId: params?.nodeId,
      nodeType: params?.node?.type,
    });
    try {
      bridge.handleProviderChange("native", { kind: "node", event: params });
    } catch (err) {
      log.debug("bridge.handleProviderChange threw", { error: err.message });
    }
  });

  try {
    await client.request("watch.subscribe", {});
  } catch (err) {
    log.debug("watch.subscribe failed, bridge disabled", { error: err.message });
    offNotif();
    try { client.disconnect(); } catch { /* ignore */ }
    return null;
  }

  log.info("opentasks event bridge active", { scope, socketPath });

  return {
    async stop() {
      try {
        await client.request("watch.unsubscribe", {});
      } catch {
        // ignore — we're shutting down anyway
      }
      offNotif();
      bridge.stop();
      try { client.disconnect(); } catch { /* ignore */ }
    },
  };
}
