#!/usr/bin/env node
/**
 * map-sidecar.mjs — MAP sidecar process for claude-code-swarm
 *
 * Thin wrapper: parses CLI args, delegates to src/ modules for connection,
 * socket server, and command handling.
 *
 * Usage: node map-sidecar.mjs --server ws://localhost:8080 --scope swarm:team --system-id system-id [--session-id id]
 *
 * When --session-id is provided, the sidecar uses per-session paths
 * (socket, PID, inbox, log) scoped to MAP_DIR/sessions/<sessionId>/.
 */

import fs from "fs";
import path from "path";
import { INBOX_PATH, SOCKET_PATH, PID_PATH, sessionPaths } from "../src/paths.mjs";
import { connectToMAP } from "../src/map-connection.mjs";
import { createSocketServer, createCommandHandler } from "../src/sidecar-server.mjs";
import { writeToInbox } from "../src/inbox.mjs";

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
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Resolve per-session or legacy paths
const sPaths = SESSION_ID
  ? sessionPaths(SESSION_ID)
  : { socketPath: SOCKET_PATH, pidPath: PID_PATH, inboxPath: INBOX_PATH };

// ── State ───────────────────────────────────────────────────────────────────

let connection = null;
let socketServer = null;
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
  if (socketServer) socketServer.close();

  try { fs.unlinkSync(sPaths.socketPath); } catch { /* ignore */ }
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure directories exist
  fs.mkdirSync(path.dirname(sPaths.inboxPath), { recursive: true });

  // Derive team name from scope
  const teamName = MAP_SCOPE.replace("swarm:", "");

  // Connect to MAP server
  connection = await connectToMAP({
    server: MAP_SERVER,
    scope: MAP_SCOPE,
    systemId: SYSTEM_ID,
    onMessage: (message) => {
      resetInactivityTimer();
      try {
        writeToInbox(message, sPaths.inboxPath);
      } catch (err) {
        process.stderr.write(`[sidecar] Failed to write inbox: ${err.message}\n`);
      }
    },
  });

  // Start UNIX socket server
  const onCommand = createCommandHandler(connection, MAP_SCOPE, registeredAgents);
  socketServer = createSocketServer(sPaths.socketPath, (command, client) => {
    resetInactivityTimer();
    onCommand(command, client);
  });

  // Start inactivity timer
  resetInactivityTimer();

  process.stderr.write(`[sidecar] Ready${SESSION_ID ? ` (session: ${SESSION_ID})` : ""}\n`);
}

main().catch((err) => {
  process.stderr.write(`[sidecar] Fatal: ${err.message}\n`);
  process.exit(1);
});
