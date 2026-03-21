#!/usr/bin/env node
/**
 * map-sidecar.mjs — MAP sidecar process for claude-code-swarm
 *
 * Two-socket, one-process architecture:
 * - Lifecycle socket: spawn/done/state/trajectory-checkpoint (existing protocol)
 * - Inbox socket: agent-inbox IPC for messaging (send/check_inbox/notify)
 *
 * Transport modes:
 * - Mesh (preferred): Embedded MeshPeer + agent-inbox Phase 2 integration.
 *   MeshPeer handles transport, encryption, discovery. Agent-inbox handles
 *   messaging, registry, federation. ~200 lines of adapter code.
 * - WebSocket (fallback): Direct MAP SDK connection (legacy mode).
 *   Used when agentic-mesh is not available.
 *
 * Usage: node map-sidecar.mjs --server ws://localhost:8080 --scope swarm:team --system-id system-id
 *          [--session-id id] [--inbox-config json] [--inactivity-timeout ms]
 *          [--mesh-peer-id id] [--mesh-enabled]
 */

import fs from "fs";
import path from "path";
import { SOCKET_PATH, PID_PATH, INBOX_SOCKET_PATH, sessionPaths } from "../src/paths.mjs";
import { connectToMAP } from "../src/map-connection.mjs";
import { createMeshPeer, createMeshInbox } from "../src/mesh-connection.mjs";
import { createSocketServer, createCommandHandler } from "../src/sidecar-server.mjs";

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultValue = "") {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}
const MAP_SERVER = getArg("server", "ws://localhost:8080");
const MAP_SCOPE = getArg("scope", "swarm:default");
const SYSTEM_ID = getArg("system-id", "system-claude-swarm");
const SESSION_ID = getArg("session-id", "");
const INACTIVITY_TIMEOUT_MS = parseInt(getArg("inactivity-timeout", ""), 10) || 30 * 60 * 1000;
const RECONNECT_INTERVAL_MS = parseInt(getArg("reconnect-interval", ""), 10) || 60000;

// Auth credential for server-driven auth negotiation (opaque — type determined by server)
const AUTH_CREDENTIAL = getArg("credential", "");

// Mesh transport args
const MESH_ENABLED = hasFlag("mesh-enabled");
const MESH_PEER_ID = getArg("mesh-peer-id", "");

// Parse inbox config (passed as JSON blob from sidecar-client)
let INBOX_CONFIG = null;
const inboxConfigJson = getArg("inbox-config", "");
if (inboxConfigJson) {
  try {
    INBOX_CONFIG = JSON.parse(inboxConfigJson);
  } catch {
    process.stderr.write("[sidecar] Warning: invalid --inbox-config JSON, inbox disabled\n");
  }
}

// Resolve per-session or legacy paths
const sPaths = SESSION_ID
  ? sessionPaths(SESSION_ID)
  : { socketPath: SOCKET_PATH, inboxSocketPath: INBOX_SOCKET_PATH, pidPath: PID_PATH };

// ── State ───────────────────────────────────────────────────────────────────

let connection = null;
let meshPeer = null;
let socketServer = null;
let commandHandler = null;
let inboxInstance = null;
let inactivityTimer = null;
let reconnectInterval = null;
let transportMode = "websocket"; // "mesh" or "websocket"
const registeredAgents = new Map();

// ── Inactivity Timer ────────────────────────────────────────────────────────

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    process.stderr.write("[sidecar] Inactivity timeout reached, shutting down\n");
    shutdown();
  }, INACTIVITY_TIMEOUT_MS);
}

// ── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown() {
  process.stderr.write("[sidecar] Shutting down...\n");

  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (reconnectInterval) clearInterval(reconnectInterval);

  // Stop agent-inbox first (it borrows the connection/peer, doesn't own it)
  if (inboxInstance) {
    try { await inboxInstance.stop(); } catch { /* ignore */ }
  }

  if (socketServer) socketServer.close();

  try { fs.unlinkSync(sPaths.socketPath); } catch { /* ignore */ }
  try { fs.unlinkSync(sPaths.inboxSocketPath); } catch { /* ignore */ }
  try { fs.unlinkSync(sPaths.pidPath); } catch { /* ignore */ }

  if (connection) {
    try { await connection.disconnect(); } catch { /* ignore */ }
  }

  // Stop MeshPeer after disconnecting the connection that uses it
  if (meshPeer) {
    try { await meshPeer.stop(); } catch { /* ignore */ }
  }

  process.exit(0);
}

// ── Signal Handlers ─────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (err) => {
  process.stderr.write(`[sidecar] Uncaught exception: ${err.message}\n`);
  shutdown();
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[sidecar] Unhandled rejection: ${msg}\n`);
  // Don't shutdown — log and continue. The rejection is likely from a
  // non-critical SDK operation (e.g. scope-based send, state update).
});

// ── Reconnection ───────────────────────────────────────────────────────────

/**
 * Attach SDK reconnection event listener to detect when built-in retries
 * are exhausted. On `reconnectFailed`, starts a slower retry loop.
 * On `reconnected`, the SDK handled it — just log.
 */
function attachReconnectionListener(conn) {
  if (!conn?.onReconnection) return;

  conn.onReconnection((event) => {
    if (event.type === "reconnectFailed") {
      process.stderr.write(
        `[sidecar] SDK reconnection exhausted (${event.error?.message || "unknown error"}), starting slow retry loop (${RECONNECT_INTERVAL_MS}ms)\n`
      );
      startSlowReconnectLoop();
    } else if (event.type === "reconnected") {
      process.stderr.write("[sidecar] SDK reconnected to MAP server\n");
    } else if (event.type === "disconnected") {
      process.stderr.write("[sidecar] Disconnected from MAP server, SDK will attempt reconnection\n");
    }
  });
}

/**
 * Slow retry loop — runs after the SDK's built-in reconnection is exhausted.
 * Periodically attempts a fresh connectToMAP(), and on success swaps in
 * the new connection, re-registers agents, and re-arms the listener.
 */
function startSlowReconnectLoop() {
  if (reconnectInterval) return; // already running

  reconnectInterval = setInterval(async () => {
    process.stderr.write("[sidecar] Attempting MAP reconnection...\n");

    try {
      const newConn = await connectToMAP({
        server: MAP_SERVER,
        scope: MAP_SCOPE,
        systemId: SYSTEM_ID,
        credential: AUTH_CREDENTIAL || undefined,
        onMessage: () => resetInactivityTimer(),
      });

      if (newConn) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;

        connection = newConn;
        if (commandHandler) commandHandler.setConnection(newConn);
        attachReconnectionListener(newConn);

        // Re-register active agents so the MAP server knows about them
        await reRegisterAgents(newConn);

        // Re-subscribe inbox events to the new connection
        subscribeInboxEvents(newConn);

        process.stderr.write("[sidecar] Reconnected to MAP server\n");
      }
    } catch (err) {
      process.stderr.write(
        `[sidecar] Reconnection attempt failed: ${err.message}\n`
      );
    }
  }, RECONNECT_INTERVAL_MS);
}

/**
 * Re-register all active agents from the registeredAgents Map after
 * a fresh connection is established.
 */
async function reRegisterAgents(conn) {
  for (const [agentId, meta] of registeredAgents) {
    try {
      await conn.spawn({
        agentId,
        name: meta.name,
        role: meta.role,
        scopes: [MAP_SCOPE],
        metadata: meta.metadata,
      });
    } catch {
      // Agent may conflict or already exist — best effort
    }
  }

  if (registeredAgents.size > 0) {
    process.stderr.write(
      `[sidecar] Re-registered ${registeredAgents.size} agent(s) after reconnection\n`
    );
  }
}

/**
 * Subscribe to inbox message.created events for outbound MAP observability.
 * Safe to call multiple times — replaces previous listener via the connection ref.
 */
function subscribeInboxEvents(conn) {
  if (!inboxInstance?.events || !conn) return;

  // The event handler closes over `conn` directly, so re-subscribing
  // with a new connection naturally uses the new connection.
  // No need to remove old listeners — they reference the old (dead) connection
  // and will silently fail, which is fine.
  inboxInstance.events.on("message.created", (message) => {
    conn.send({ scope: MAP_SCOPE }, {
      type: "inbox.message",
      messageId: message.id,
      from: message.sender_id,
      to: (message.recipients || []).map((r) => r.agent_id),
      contentType: message.content?.type || "text",
      threadTag: message.thread_tag,
      importance: message.importance,
    }, { relationship: "broadcast" }).catch(() => {
      // Best-effort — don't block on MAP delivery
    });
  });
}

// ── Transport Setup ─────────────────────────────────────────────────────────

/**
 * Try to start with MeshPeer transport (preferred).
 * Returns true if mesh transport was established.
 */
async function tryMeshTransport() {
  const teamName = MAP_SCOPE.replace("swarm:", "");
  const peerId = MESH_PEER_ID || `${teamName}-sidecar`;

  const result = await createMeshPeer({
    peerId,
    scope: MAP_SCOPE,
    systemId: SYSTEM_ID,
    mapServer: MAP_SERVER !== "ws://localhost:8080" ? MAP_SERVER : undefined,
    onMessage: () => resetInactivityTimer(),
  });

  if (!result) return false;

  meshPeer = result.peer;
  connection = result.connection;
  transportMode = "mesh";

  // Start agent-inbox with MeshPeer (Phase 2 integration)
  if (INBOX_CONFIG || true) {
    // Always try mesh inbox — it handles agent registry + messaging
    inboxInstance = await createMeshInbox({
      meshPeer: result.peer,
      scope: MAP_SCOPE,
      systemId: SYSTEM_ID,
      socketPath: sPaths.inboxSocketPath,
      inboxConfig: INBOX_CONFIG || {},
    });
  }

  return true;
}

/**
 * Start with direct MAP SDK WebSocket transport (fallback).
 */
async function startWebSocketTransport() {
  connection = await connectToMAP({
    server: MAP_SERVER,
    scope: MAP_SCOPE,
    systemId: SYSTEM_ID,
    credential: AUTH_CREDENTIAL || undefined,
    onMessage: () => {
      resetInactivityTimer();
    },
  });

  transportMode = "websocket";

  // Start agent-inbox with MAP connection (legacy mode)
  if (INBOX_CONFIG && connection) {
    inboxInstance = await startLegacyAgentInbox(connection);
  }
}

/**
 * Start agent-inbox in legacy mode (shared MAP connection, no MeshPeer).
 */
async function startLegacyAgentInbox(mapConnection) {
  if (!INBOX_CONFIG) return null;

  try {
    const { createAgentInbox } = await import("agent-inbox");

    const peers = INBOX_CONFIG.federation?.peers || [];
    const federationConfig = peers.length > 0
      ? {
          systemId: SYSTEM_ID,
          peers,
          routing: INBOX_CONFIG.federation?.routing,
          trust: INBOX_CONFIG.federation?.trust,
        }
      : undefined;

    const opts = {
      connection: mapConnection,
      config: {
        socketPath: sPaths.inboxSocketPath,
        scope: MAP_SCOPE,
        federation: federationConfig,
      },
      enableFederation: peers.length > 0,
      sqlitePath: INBOX_CONFIG.sqlite || undefined,
      httpPort: INBOX_CONFIG.httpPort || 0,
      webhooks: INBOX_CONFIG.webhooks?.length ? INBOX_CONFIG.webhooks : undefined,
    };

    const inbox = await createAgentInbox(opts);
    process.stderr.write(`[sidecar] Agent Inbox started (websocket mode) on ${sPaths.inboxSocketPath}\n`);
    return inbox;
  } catch (err) {
    process.stderr.write(`[sidecar] Agent Inbox not available: ${err.message}\n`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure directories exist
  fs.mkdirSync(path.dirname(sPaths.pidPath), { recursive: true });

  // Try mesh transport first, fall back to WebSocket
  if (MESH_ENABLED) {
    const meshOk = await tryMeshTransport();
    if (!meshOk) {
      process.stderr.write("[sidecar] Mesh transport unavailable, falling back to WebSocket\n");
      await startWebSocketTransport();
    }
  } else {
    await startWebSocketTransport();
  }

  // Attach reconnection listener for WebSocket mode
  // (mesh mode uses an embedded in-process server, no remote connection to lose)
  if (transportMode === "websocket") {
    if (connection) {
      attachReconnectionListener(connection);
    } else {
      // Initial connection failed — start slow retry loop immediately
      process.stderr.write("[sidecar] Initial MAP connection failed, starting slow retry loop\n");
      startSlowReconnectLoop();
    }
  }

  // Subscribe to inbox message.created events for outbound MAP observability
  subscribeInboxEvents(connection);
  if (inboxInstance?.events && connection) {
    process.stderr.write("[sidecar] Subscribed to inbox message.created events for MAP bridge\n");
  }

  // Start lifecycle UNIX socket server
  commandHandler = createCommandHandler(connection, MAP_SCOPE, registeredAgents, {
    inboxInstance,
    meshPeer,
    transportMode,
  });
  socketServer = createSocketServer(sPaths.socketPath, (command, client) => {
    resetInactivityTimer();
    commandHandler(command, client);
  });

  // Start inactivity timer
  resetInactivityTimer();

  const modeLabel = transportMode === "mesh" ? "mesh" : "websocket";
  const inboxLabel = inboxInstance ? " [inbox active]" : "";
  process.stderr.write(`[sidecar] Ready (${modeLabel})${SESSION_ID ? ` (session: ${SESSION_ID})` : ""}${inboxLabel}\n`);
}

main().catch((err) => {
  process.stderr.write(`[sidecar] Fatal: ${err.message}\n`);
  process.exit(1);
});
