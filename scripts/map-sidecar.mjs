#!/usr/bin/env node
/**
 * map-sidecar.mjs — MAP sidecar process for claude-code-swarm
 *
 * Two-socket, one-process architecture:
 * - Lifecycle socket: spawn/done/state/trajectory-checkpoint (existing protocol)
 * - Inbox socket: agent-inbox IPC for messaging (send/check_inbox/notify)
 * Both sockets share a single MAP connection.
 *
 * Incoming MAP messages are handled by agent-inbox (via useConnection),
 * which stores them in memory/SQLite and serves them via the inbox IPC socket.
 * The inject hook reads messages via check_inbox IPC.
 *
 * Usage: node map-sidecar.mjs --server ws://localhost:8080 --scope swarm:team --system-id system-id
 *          [--session-id id] [--inbox-config json] [--inactivity-timeout ms]
 */

import fs from "fs";
import path from "path";
import { SOCKET_PATH, PID_PATH, INBOX_SOCKET_PATH, sessionPaths } from "../src/paths.mjs";
import { connectToMAP } from "../src/map-connection.mjs";
import { createSocketServer, createCommandHandler } from "../src/sidecar-server.mjs";

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultValue = "") {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}
const MAP_SERVER = getArg("server", "ws://localhost:8080");
const MAP_SCOPE = getArg("scope", "swarm:default");
const SYSTEM_ID = getArg("system-id", "system-claude-swarm");
const SESSION_ID = getArg("session-id", "");
const INACTIVITY_TIMEOUT_MS = parseInt(getArg("inactivity-timeout", ""), 10) || 30 * 60 * 1000;

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
let socketServer = null;
let inboxInstance = null;
let inactivityTimer = null;
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

  // Stop agent-inbox first (it borrows the connection, doesn't own it)
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

// ── Agent Inbox Setup ───────────────────────────────────────────────────────

async function startAgentInbox(mapConnection) {
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
    process.stderr.write(`[sidecar] Agent Inbox started on ${sPaths.inboxSocketPath}\n`);
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

  // Connect to MAP server
  connection = await connectToMAP({
    server: MAP_SERVER,
    scope: MAP_SCOPE,
    systemId: SYSTEM_ID,
    onMessage: () => {
      resetInactivityTimer();
      // Incoming messages are handled by agent-inbox via useConnection().
      // The sidecar's onMessage only resets the inactivity timer.
    },
  });

  // Start agent-inbox if configured (shares the MAP connection)
  if (INBOX_CONFIG && connection) {
    inboxInstance = await startAgentInbox(connection);
  }

  // Start lifecycle UNIX socket server
  const onCommand = createCommandHandler(connection, MAP_SCOPE, registeredAgents);
  socketServer = createSocketServer(sPaths.socketPath, (command, client) => {
    resetInactivityTimer();
    onCommand(command, client);
  });

  // Start inactivity timer
  resetInactivityTimer();

  process.stderr.write(`[sidecar] Ready${SESSION_ID ? ` (session: ${SESSION_ID})` : ""}${inboxInstance ? " [inbox active]" : ""}\n`);
}

main().catch((err) => {
  process.stderr.write(`[sidecar] Fatal: ${err.message}\n`);
  process.exit(1);
});
