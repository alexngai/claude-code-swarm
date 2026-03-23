/**
 * mesh-connection.mjs — MeshPeer creation and management for claude-code-swarm
 *
 * Creates an embedded MeshPeer instance that replaces the direct MAP SDK
 * WebSocket connection. When combined with agent-inbox, provides:
 * - Agent discovery via MapServer registry
 * - Federation with hop/loop detection (when peers are connected)
 * - Structured messaging (threading, read tracking, delivery)
 *
 * Uses MeshPeer.createEmbedded() (agentic-mesh >=0.2.0) to run a fully
 * in-process MapServer without requiring a network transport. Transport
 * can be added later via start() for P2P connectivity if needed.
 *
 * Falls back to direct MAP SDK connection when agentic-mesh is unavailable.
 */

/**
 * Create an embedded MeshPeer with an in-process MapServer.
 * Uses MeshPeer.createEmbedded() — no transport required for local operation.
 * Returns { peer, connection } where connection is a MeshPeer AgentConnection
 * (has send, updateState, updateMetadata, unregister, broadcastToScope, etc.).
 * Returns null if agentic-mesh is not available.
 *
 * @param {object} opts
 * @param {string} opts.peerId - MeshPeer ID (e.g. "swarm-leader")
 * @param {string} opts.scope - MAP scope name
 * @param {string} opts.systemId - System identifier
 * @param {Function} [opts.onMessage] - Message callback
 * @param {object} [opts.transport] - Custom transport for P2P connectivity (optional).
 * @returns {Promise<{peer: object, connection: object}|null>}
 */
import { createLogger } from "./log.mjs";
import { resolvePackage } from "./swarmkit-resolver.mjs";

const log = createLogger("mesh");

export async function createMeshPeer({ peerId, scope, systemId, onMessage, transport }) {
  try {
    const agenticMesh = await resolvePackage("agentic-mesh");
    if (!agenticMesh) throw new Error("agentic-mesh not available");
    const { MeshPeer } = agenticMesh;

    const peer = MeshPeer.createEmbedded({ peerId, transport });

    // Register as an agent on the MeshPeer's embedded MapServer
    const teamName = scope.replace("swarm:", "");
    const agentName = `${teamName}-sidecar`;

    const connection = await peer.createAgent({
      agentId: `${peerId}-agent`,
      name: agentName,
      role: "sidecar",
      metadata: {
        systemId,
        type: "claude-code-swarm-sidecar",
        transport: "mesh",
      },
    });

    if (onMessage) {
      connection.on("message", onMessage);
    }

    log.info("MeshPeer started", { peerId, agent: agentName, scope });

    return { peer, connection };
  } catch (err) {
    log.warn("agentic-mesh not available", { error: err.message });
    return null;
  }
}

/**
 * Create agent-inbox with an embedded MeshPeer (Phase 2 integration).
 * Returns the inbox instance or null if agent-inbox is unavailable.
 *
 * @param {object} opts
 * @param {object} opts.meshPeer - MeshPeer instance
 * @param {string} opts.scope - MAP scope name
 * @param {string} opts.systemId - System identifier
 * @param {string} opts.socketPath - IPC socket path for inbox
 * @param {object} [opts.inboxConfig] - Additional inbox config (sqlite, webhooks, federation)
 * @returns {Promise<object|null>}
 */
export async function createMeshInbox({ meshPeer, scope, systemId, socketPath, inboxConfig }) {
  try {
    const agentInboxMod = await resolvePackage("agent-inbox");
    if (!agentInboxMod) throw new Error("agent-inbox not available");
    const { createAgentInbox } = agentInboxMod;

    const peers = inboxConfig?.federation?.peers || [];
    const federationConfig = peers.length > 0
      ? {
          systemId,
          peers,
          routing: inboxConfig?.federation?.routing,
          trust: inboxConfig?.federation?.trust,
        }
      : undefined;

    const opts = {
      meshPeer,
      enableFederation: peers.length > 0,
      config: {
        socketPath,
        scope,
        federation: federationConfig,
      },
      sqlitePath: inboxConfig?.sqlite || undefined,
      httpPort: inboxConfig?.httpPort || 0,
      webhooks: inboxConfig?.webhooks?.length ? inboxConfig.webhooks : undefined,
    };

    const inbox = await createAgentInbox(opts);
    log.info("Agent Inbox started with MeshPeer", { socketPath });
    return inbox;
  } catch (err) {
    log.warn("Agent Inbox (mesh mode) not available", { error: err.message });
    return null;
  }
}

/**
 * Fire-and-forget: send a single event via a temporary MeshPeer.
 * Creates an ephemeral peer, sends, shuts down. Silent on failure.
 * Used as fallback when the sidecar is unavailable.
 */
export async function meshFireAndForget(config, event) {
  try {
    const agenticMeshMod = await resolvePackage("agentic-mesh");
    if (!agenticMeshMod) throw new Error("agentic-mesh not available");
    const { MeshPeer } = agenticMeshMod;
    const scope = config.map?.scope || "swarm:default";
    const teamName = scope.replace("swarm:", "");

    const peer = MeshPeer.createEmbedded({
      peerId: `${teamName}-hook-${Date.now()}`,
    });

    const conn = await peer.createAgent({
      name: `${teamName}-hook`,
      role: "hook",
    });

    await conn.send({ scope }, event);
    await conn.unregister();
    await peer.stop();
  } catch {
    // Silently drop — never block the agent
  }
}
